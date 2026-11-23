import { addOptimalPadding, clamp, clampCropRect } from './cropGeometry';
import type {
  BackgroundAnalysis,
  CropRect,
  DetectedRegion,
  DetectionConfidence,
  ProductDetectionResult,
} from './imageCropper.types';

export interface RgbaImageInput {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

interface LabColor {
  L: number;
  a: number;
  b: number;
}

interface BgCluster extends LabColor {
  r: number;
  g: number;
  bRgb: number;
  weight: number;
}

function srgbToLinear(c: number): number {
  const u = c / 255;
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function rgbToLab(r: number, g: number, b: number): LabColor {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / 1.08883;

  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function labDistanceSq(c1: LabColor, c2: LabColor): number {
  const dL = c1.L - c2.L;
  const da = c1.a - c2.a;
  const db = c1.b - c2.b;
  return dL * dL + da * da + db * db;
}

/**
 * Analyzes image border strips + corners to estimate background type, dominant clusters,
 * transparency, and surface variance (white, gray, black, transparent, or textured).
 */
function analyzeBorderBackground(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { analysis: BackgroundAnalysis; clusters: BgCluster[]; medianL: number; meanChroma: number } {
  const stripX = Math.max(2, Math.round(width * 0.045));
  const stripY = Math.max(2, Math.round(height * 0.045));

  let totalBorder = 0;
  let transparentBorder = 0;

  // Quantize opaque border samples into 12-bit buckets (4x4x4 bits) to cluster quickly
  const buckets = new Map<
    number,
    { sumR: number; sumG: number; sumB: number; count: number }
  >();
  const sampleLabs: LabColor[] = [];

  for (let y = 0; y < height; y++) {
    const isRowBorder = y < stripY || y >= height - stripY;
    const stepX = isRowBorder ? 1 : 1;
    for (let x = 0; x < width; x += stepX) {
      if (!isRowBorder && x >= stripX && x < width - stripX) {
        // Jump across interior directly to right border
        x = width - stripX - 1;
        continue;
      }
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      totalBorder++;
      if (a < 40) {
        transparentBorder++;
        continue;
      }
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const entry = buckets.get(key);
      if (entry) {
        entry.sumR += r;
        entry.sumG += g;
        entry.sumB += b;
        entry.count++;
      } else {
        buckets.set(key, { sumR: r, sumG: g, sumB: b, count: 1 });
      }
    }
  }

  const borderTransparentRatio = totalBorder > 0 ? transparentBorder / totalBorder : 0;

  // Pick top clusters merged within Lab distance < 14
  const sortedBuckets = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
  const clusters: BgCluster[] = [];
  const totalOpaque = Math.max(1, totalBorder - transparentBorder);

  for (const bkt of sortedBuckets) {
    const r = bkt.sumR / bkt.count;
    const g = bkt.sumG / bkt.count;
    const bRgb = bkt.sumB / bkt.count;
    const lab = rgbToLab(r, g, bRgb);
    sampleLabs.push(lab);

    let merged = false;
    for (const c of clusters) {
      if (labDistanceSq(c, lab) < 14 * 14) {
        const wTotal = c.weight + bkt.count;
        c.r = (c.r * c.weight + r * bkt.count) / wTotal;
        c.g = (c.g * c.weight + g * bkt.count) / wTotal;
        c.bRgb = (c.bRgb * c.weight + bRgb * bkt.count) / wTotal;
        const mergedLab = rgbToLab(c.r, c.g, c.bRgb);
        c.L = mergedLab.L;
        c.a = mergedLab.a;
        c.b = mergedLab.b;
        c.weight = wTotal;
        merged = true;
        break;
      }
    }
    if (!merged && clusters.length < 4) {
      clusters.push({
        r,
        g,
        bRgb,
        L: lab.L,
        a: lab.a,
        b: lab.b,
        weight: bkt.count,
      });
    }
  }

  if (clusters.length === 0) {
    clusters.push({ r: 255, g: 255, bRgb: 255, L: 100, a: 0, b: 0, weight: 1 });
  }

  // Re-normalize cluster weights
  let sumWeight = 0;
  for (const c of clusters) sumWeight += c.weight;
  for (const c of clusters) c.weight = c.weight / Math.max(1, sumWeight);

  // Compute border dispersion against top cluster(s)
  let varianceSum = 0;
  let varianceCount = 0;
  for (const bkt of sortedBuckets.slice(0, 60)) {
    const r = bkt.sumR / bkt.count;
    const g = bkt.sumG / bkt.count;
    const bRgb = bkt.sumB / bkt.count;
    const lab = rgbToLab(r, g, bRgb);
    let minD2 = Infinity;
    for (const c of clusters) {
      const d2 = labDistanceSq(c, lab);
      if (d2 < minD2) minD2 = d2;
    }
    varianceSum += Math.sqrt(minD2) * bkt.count;
    varianceCount += bkt.count;
  }
  const borderVariance = varianceCount > 0 ? varianceSum / varianceCount : 0;

  const primary = clusters[0];
  const primaryChroma = Math.hypot(primary.a, primary.b);

  let kind: BackgroundAnalysis['kind'] = 'mixed';
  if (borderTransparentRatio >= 0.45) {
    kind = 'transparent';
  } else if (borderVariance > 14 && clusters.length >= 3 && primary.weight < 0.55) {
    kind = 'textured';
  } else if (primary.L >= 86 && primaryChroma < 11 && borderVariance < 14) {
    kind = 'white';
  } else if (primary.L <= 24 && primaryChroma < 12 && borderVariance < 14) {
    kind = 'dark';
  } else if (primaryChroma < 12 && borderVariance < 16) {
    kind = 'gray';
  }

  return {
    analysis: {
      kind,
      borderTransparentRatio: Number(borderTransparentRatio.toFixed(3)),
      dominantColors: clusters.map((c) => ({
        r: Math.round(c.r),
        g: Math.round(c.g),
        b: Math.round(c.bRgb),
        weight: Number(c.weight.toFixed(3)),
      })),
      borderVariance: Number(borderVariance.toFixed(2)),
    },
    clusters,
    medianL: primary.L,
    meanChroma: primaryChroma,
  };
}

/**
 * Separates foreground product pixels from background & cast shadows using:
 *  - Alpha channel (for transparent assets)
 *  - Multi-cluster CIE L*a*b* distance
 *  - Sobel structural edge magnitude
 *  - Cast-shadow suppression (darker luminance, near-zero chroma delta, low inner texture/edges)
 */
function buildForegroundMask(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  bg: ReturnType<typeof analyzeBorderBackground>,
): {
  mask: Uint8Array;
  saliency: Float32Array;
  edges: Float32Array;
  labBuffer: Float32Array;
} {
  const n = width * height;
  const labBuffer = new Float32Array(n * 3);
  const lum = new Float32Array(n);
  const edges = new Float32Array(n);
  const colorDelta = new Float32Array(n);
  const shadowPenalty = new Float32Array(n);

  const clusters = bg.clusters.slice(0, 3);
  const isTransparentBg = bg.analysis.kind === 'transparent';

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const alpha = data[idx + 3];
    if (alpha < 30) {
      lum[i] = 0;
      colorDelta[i] = 0;
      continue;
    }

    const lab = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
    labBuffer[i * 3] = lab.L;
    labBuffer[i * 3 + 1] = lab.a;
    labBuffer[i * 3 + 2] = lab.b;
    lum[i] = lab.L;

    if (isTransparentBg) {
      colorDelta[i] = alpha >= 40 ? 45 : 0;
      continue;
    }

    let bestD2 = Infinity;
    let bestCluster = clusters[0];
    for (let k = 0; k < clusters.length; k++) {
      const d2 = labDistanceSq(lab, clusters[k]);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestCluster = clusters[k];
      }
    }

    const dE = Math.sqrt(bestD2);
    const dL = lab.L - bestCluster.L;
    const dChroma = Math.hypot(lab.a - bestCluster.a, lab.b - bestCluster.b);

    // Cast shadows typically sit on neutral/light workbenches, are darker (dL < -6 & dL > -45),
    // preserve hue/neutral chroma (dChroma < 8.5), and have smooth luminance gradients.
    if (
      bestCluster.L > 42 &&
      dL < -5 &&
      dL > -44 &&
      dChroma < 9.5 &&
      dChroma < Math.abs(dL) * 0.34
    ) {
      shadowPenalty[i] = 1 - clamp(dChroma / 9.5, 0, 1);
    }

    // Weight chromatic difference higher so subtle color parts stand out against gray/white/dark bgs
    colorDelta[i] = dE + dChroma * 0.45;
  }

  // Sobel edge magnitude on L* luminance
  let maxEdge = 1;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -lum[i - width - 1] +
        lum[i - width + 1] -
        2 * lum[i - 1] +
        2 * lum[i + 1] -
        lum[i + width - 1] +
        lum[i + width + 1];
      const gy =
        -lum[i - width - 1] -
        2 * lum[i - width] -
        lum[i - width + 1] +
        lum[i + width - 1] +
        2 * lum[i + width] +
        lum[i + width + 1];
      const g = Math.hypot(gx, gy) * 0.25;
      edges[i] = g;
      if (g > maxEdge) maxEdge = g;
    }
  }

  // Build adaptive threshold from border variance + image distribution
  const baseNoiseFloor = Math.max(7.5, bg.analysis.borderVariance * 1.45);
  const strongColorThreshold = Math.max(13, baseNoiseFloor * 1.25);

  const saliency = new Float32Array(n);
  const mask = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const alpha = data[idx + 3];
    if (alpha < 30) {
      mask[i] = 0;
      saliency[i] = 0;
      continue;
    }
    if (isTransparentBg) {
      mask[i] = alpha >= 55 ? 1 : 0;
      saliency[i] = alpha / 255;
      continue;
    }

    const cd = colorDelta[i];
    const edgeScore = edges[i];
    const sp = shadowPenalty[i];

    // If pixel looks like soft cast shadow without a crisp structural edge, suppress it
    const suppressedCd = sp > 0 && edgeScore < 14 ? cd * (1 - 0.72 * sp) : cd;

    const score = suppressedCd / strongColorThreshold + edgeScore / 18;
    saliency[i] = score;

    if (suppressedCd >= strongColorThreshold || (edgeScore >= 12.5 && suppressedCd >= baseNoiseFloor * 0.7)) {
      mask[i] = 1;
    }
  }

  // For non-transparent images: lightly dilate along strong edge-connected neighbors (hysteresis)
  // while keeping background borders clean, then close 1px gaps so thin teeth/belts stay intact.
  if (!isTransparentBg) {
    const hysteresis = new Uint8Array(mask);
    const softCd = strongColorThreshold * 0.68;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const i = y * width + x;
          if (hysteresis[i]) continue;
          const sp = shadowPenalty[i];
          if (sp > 0.45 && edges[i] < 13) continue;
          const effectiveCd = sp > 0 && edges[i] < 14 ? colorDelta[i] * (1 - 0.72 * sp) : colorDelta[i];
          const hasStrongNeighbor =
            hysteresis[i - 1] ||
            hysteresis[i + 1] ||
            hysteresis[i - width] ||
            hysteresis[i + width];
          if (hasStrongNeighbor && (effectiveCd >= softCd || edges[i] >= 12.5)) {
            hysteresis[i] = 1;
          }
        }
      }
    }

    // 3x3 majority/bridge closing: fills 1px pinholes without losing 2px thin belt edges
    const closed = new Uint8Array(hysteresis);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (closed[i]) continue;
        const hBridge = hysteresis[i - 1] && hysteresis[i + 1];
        const vBridge = hysteresis[i - width] && hysteresis[i + width];
        const diag1 = hysteresis[i - width - 1] && hysteresis[i + width + 1];
        const diag2 = hysteresis[i - width + 1] && hysteresis[i + width - 1];
        if ((hBridge && vBridge) || (hBridge && (diag1 || diag2)) || (vBridge && (diag1 || diag2))) {
          closed[i] = 1;
        }
      }
    }

    // Remove isolated 1-pixel speckles (0 foreground neighbors out of 8)
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        if (!closed[i]) continue;
        const neighborSum =
          closed[i - 1] +
          closed[i + 1] +
          closed[i - width] +
          closed[i + width] +
          closed[i - width - 1] +
          closed[i - width + 1] +
          closed[i + width - 1] +
          closed[i + width + 1];
        if (neighborSum === 0) closed[i] = 0;
      }
    }

    return { mask: closed, saliency, edges, labBuffer };
  }

  return { mask, saliency, edges, labBuffer };
}

interface RawComponent {
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pixelCount: number;
  sumX: number;
  sumY: number;
  sumSaliency: number;
  sumEdge: number;
  borderTouches: number;
}

function extractConnectedComponents(
  mask: Uint8Array,
  saliency: Float32Array,
  edges: Float32Array,
  width: number,
  height: number,
): RawComponent[] {
  const n = width * height;
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const components: RawComponent[] = [];
  const totalPixels = n;

  // Allow tiny thin components down to ~0.08% if elongated or edge-rich
  const minAbsolutePixels = Math.max(8, Math.round(totalPixels * 0.0005));

  for (let start = 0; start < n; start++) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let pixelCount = 0;
    let sumX = 0;
    let sumY = 0;
    let sumSaliency = 0;
    let sumEdge = 0;
    let borderTouches = 0;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx / width) | 0;

      pixelCount++;
      sumX += x;
      sumY += y;
      sumSaliency += saliency[idx];
      sumEdge += edges[idx];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x <= 1 || x >= width - 2 || y <= 1 || y >= height - 2) {
        borderTouches++;
      }

      // 8-connected neighbors preserve thin diagonal belts & spokes
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const rowOffset = ny * width;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const ni = rowOffset + nx;
          if (mask[ni] && !visited[ni]) {
            visited[ni] = 1;
            queue[tail++] = ni;
          }
        }
      }
    }

    if (pixelCount >= minAbsolutePixels) {
      components.push({
        id: components.length + 1,
        minX,
        minY,
        maxX,
        maxY,
        pixelCount,
        sumX,
        sumY,
        sumSaliency,
        sumEdge,
        borderTouches,
      });
    }
  }

  return components;
}

interface MergedCluster {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pixelCount: number;
  sumX: number;
  sumY: number;
  sumSaliency: number;
  sumEdge: number;
  borderTouches: number;
  memberCount: number;
}

function boxGapNormalized(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
  width: number,
  height: number,
): number {
  const gx = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX)) / width;
  const gy = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY)) / height;
  return Math.hypot(gx, gy);
}

/**
 * Merges fragments belonging to one continuous/multi-part assembly (overlapping bboxes,
 * collinear belt markings, tiny close accessories) while preserving distinctly separated products.
 */
function groupRelatedComponents(
  raw: RawComponent[],
  width: number,
  height: number,
): MergedCluster[] {
  if (raw.length === 0) return [];

  const sorted = [...raw].sort((a, b) => b.pixelCount - a.pixelCount);
  const clusters: MergedCluster[] = sorted.map((c) => ({
    minX: c.minX,
    minY: c.minY,
    maxX: c.maxX,
    maxY: c.maxY,
    pixelCount: c.pixelCount,
    sumX: c.sumX,
    sumY: c.sumY,
    sumSaliency: c.sumSaliency,
    sumEdge: c.sumEdge,
    borderTouches: c.borderTouches,
    memberCount: 1,
  }));

  // Iteratively merge overlapping boxes OR tight parts belonging to one product
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const A = clusters[i];
        const B = clusters[j];
        const gap = boxGapNormalized(A, B, width, height);

        const areaA = ((A.maxX - A.minX + 1) * (A.maxY - A.minY + 1)) / (width * height);
        const areaB = ((B.maxX - B.minX + 1) * (B.maxY - B.minY + 1)) / (width * height);
        const minBoxArea = Math.min(areaA, areaB);
        const maxBoxArea = Math.max(areaA, areaB);

        // Merge if:
        // 1) Bounding boxes overlap or nearly touch (<= 2.2% gap, e.g. segmented teeth or belt rings)
        // 2) A tiny satellite fragment (< 15% of the main object's pixels) sits within 5.5% of the main object
        const isTinySatellite = B.pixelCount < A.pixelCount * 0.16 && minBoxArea < maxBoxArea * 0.25 && gap <= 0.055;
        const isTouchingAssembly = gap <= 0.022;

        if (isTouchingAssembly || isTinySatellite) {
          A.minX = Math.min(A.minX, B.minX);
          A.minY = Math.min(A.minY, B.minY);
          A.maxX = Math.max(A.maxX, B.maxX);
          A.maxY = Math.max(A.maxY, B.maxY);
          A.pixelCount += B.pixelCount;
          A.sumX += B.sumX;
          A.sumY += B.sumY;
          A.sumSaliency += B.sumSaliency;
          A.sumEdge += B.sumEdge;
          A.borderTouches += B.borderTouches;
          A.memberCount += B.memberCount;
          clusters.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return clusters;
}

/**
 * Computes final product regions, confidence score, and optimal 8-12% padded crop.
 * Pure typed-array CPU algorithm — executes identically in Web Workers and Node tests.
 */
export function detectProductRegionsFromRgba(input: RgbaImageInput): ProductDetectionResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { data, width, height } = input;
  const fullCrop: CropRect = { x: 0, y: 0, width: 1, height: 1 };

  if (!width || !height || width < 4 || height < 4 || data.length < width * height * 4) {
    return {
      confidence: 'low',
      score: 0,
      regions: [],
      selectedRegionIndex: 0,
      suggestedCrop: fullCrop,
      background: {
        kind: 'mixed',
        borderTransparentRatio: 0,
        dominantColors: [],
        borderVariance: 0,
      },
      processingMs: 0,
      usedFallbackReason: 'ابعاد تصویر برای تحلیل خودکار کافی نیست.',
    };
  }

  const bg = analyzeBorderBackground(data, width, height);
  const { mask, saliency, edges } = buildForegroundMask(data, width, height, bg);
  const rawComponents = extractConnectedComponents(mask, saliency, edges, width, height);
  const mergedClusters = groupRelatedComponents(rawComponents, width, height);

  const totalPixels = width * height;
  const meaningfulRegions: DetectedRegion[] = [];

  for (let i = 0; i < mergedClusters.length; i++) {
    const c = mergedClusters[i];
    const boxW = (c.maxX - c.minX + 1) / width;
    const boxH = (c.maxY - c.minY + 1) / height;
    const boxArea = boxW * boxH;
    const pixelAreaRatio = c.pixelCount / totalPixels;

    // Ignore minuscule dust/artifacts unless image is overwhelmingly empty
    if (boxArea < 0.004 && pixelAreaRatio < 0.0015) continue;

    const meanSaliency = c.sumSaliency / Math.max(1, c.pixelCount);
    const meanEdge = c.sumEdge / Math.max(1, c.pixelCount);
    const centroidX = c.sumX / Math.max(1, c.pixelCount) / width;
    const centroidY = c.sumY / Math.max(1, c.pixelCount) / height;

    // Distance from center (0 = dead center, 0.7 = corner)
    const centerDist = Math.hypot(centroidX - 0.5, centroidY - 0.5);
    const centralityScore = 1 - clamp(centerDist / 0.65, 0, 1);

    const borderTouchRatio = c.borderTouches / Math.max(1, c.pixelCount);
    const touchesBorder = borderTouchRatio > 0.06;

    const aspect = boxW / Math.max(1e-5, boxH);
    const isElongated = aspect >= 2.2 || aspect <= 0.45;

    // Evaluate object confidence
    const contrastScore = clamp((meanSaliency - 0.75) / 2.4, 0, 1);
    const edgeRichness = clamp(meanEdge / 14, 0, 1);
    const sizeSuitability =
      boxArea < 0.01
        ? clamp(boxArea / 0.01, 0.1, 0.6)
        : boxArea > 0.94
          ? 0.55
          : 1;

    // Penalize objects glued heavily onto background borders (often cluttered backdrop instead of product)
    const borderPenalty = touchesBorder ? clamp((borderTouchRatio - 0.06) * 2.2, 0, 0.35) : 0;

    let regionConfidence =
      0.42 * contrastScore +
      0.24 * sizeSuitability +
      0.2 * centralityScore +
      0.14 * edgeRichness -
      borderPenalty;

    if (bg.analysis.kind === 'transparent' && pixelAreaRatio >= 0.01 && pixelAreaRatio <= 0.92) {
      regionConfidence = Math.max(regionConfidence, 0.86);
    }

    regionConfidence = clamp(regionConfidence, 0.05, 0.99);

    const tightRect = clampCropRect({
      x: c.minX / width,
      y: c.minY / height,
      width: (c.maxX - c.minX + 1) / width,
      height: (c.maxY - c.minY + 1) / height,
    });

    // Padding: ~10% (within 8-12%), slightly smaller min floor for already large objects
    const suggestedCrop = addOptimalPadding(tightRect, 0.1, 0.012);

    const confLevel: DetectionConfidence =
      regionConfidence >= 0.68 ? 'high' : regionConfidence >= 0.4 ? 'medium' : 'low';

    meaningfulRegions.push({
      id: `region-${i + 1}`,
      rect: tightRect,
      suggestedCrop,
      areaRatio: Number(boxArea.toFixed(4)),
      confidence: Number(regionConfidence.toFixed(3)),
      confidenceLevel: confLevel,
      aspectRatio: Number(aspect.toFixed(3)),
      isElongated,
      touchesBorder,
      centroid: {
        x: Number(centroidX.toFixed(3)),
        y: Number(centroidY.toFixed(3)),
      },
    });
  }

  // Rank meaningful regions: prioritize sizable, crisp, centered foreground objects
  meaningfulRegions.sort((a, b) => {
    const rankA = a.confidence * 0.58 + clamp(Math.sqrt(a.areaRatio), 0, 0.9) * 0.42;
    const rankB = b.confidence * 0.58 + clamp(Math.sqrt(b.areaRatio), 0, 0.9) * 0.42;
    return rankB - rankA;
  });

  // Cap secondary clutter: keep genuinely significant distinct objects (at least 10% of primary area)
  const primary = meaningfulRegions[0];
  const filteredRegions = primary
    ? meaningfulRegions
        .filter((r, idx) => idx === 0 || (r.areaRatio >= primary.areaRatio * 0.14 && r.confidence >= 0.32))
        .slice(0, 6)
    : [];

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();

  if (!primary) {
    return {
      confidence: 'low',
      score: 0.12,
      regions: [],
      selectedRegionIndex: 0,
      suggestedCrop: fullCrop,
      background: bg.analysis,
      processingMs: Math.round(t1 - t0),
      usedFallbackReason: 'مرز مشخصی بین محصول و پس‌زمینه تشخیص داده نشد.',
    };
  }

  // Check if whole image is noisy / fragmented across many equal-size blobs (cluttered floor)
  let finalScore = primary.confidence;
  if (filteredRegions.length >= 4 && primary.areaRatio < 0.25 && bg.analysis.borderVariance > 16) {
    finalScore *= 0.72;
  }

  // If foreground almost completely fills frame (>94% area) with uniform margin, reduce confidence
  // so user isn't misled by an unneeded tiny trim, unless transparent PNG.
  if (
    bg.analysis.kind !== 'transparent' &&
    primary.rect.width > 0.95 &&
    primary.rect.height > 0.95 &&
    primary.touchesBorder
  ) {
    finalScore = Math.min(finalScore, 0.36);
  }

  finalScore = clamp(finalScore, 0.05, 0.99);
  const overallConfidence: DetectionConfidence =
    finalScore >= 0.68 ? 'high' : finalScore >= 0.4 ? 'medium' : 'low';

  return {
    confidence: overallConfidence,
    score: Number(finalScore.toFixed(3)),
    regions: filteredRegions,
    selectedRegionIndex: 0,
    // Low confidence MUST fall back safely to full original image!
    suggestedCrop: overallConfidence === 'low' ? fullCrop : primary.suggestedCrop,
    background: bg.analysis,
    processingMs: Math.round(t1 - t0),
    usedFallbackReason:
      overallConfidence === 'low'
        ? 'تفکیک پس‌زمینه اطمینان بالا ندارد؛ محدوده برش روی تصویر کامل تنظیم شد.'
        : undefined,
  };
}
