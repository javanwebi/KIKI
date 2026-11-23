import * as ort from 'onnxruntime-web/wasm';

export interface ClientAiSegmentationResult {
  width: number;
  height: number;
  alphaMask: Uint8Array;
  whiteBgDataUrl: string;
}

const U2NET_MODEL_URL = '/models/u2netp.onnx';
const U2NET_INPUT_SIZE = 320;
const MODEL_TIMEOUT_MS = 28_000;
const MAX_INFERENCE_DIM = 860;

// Standard ImageNet channel normalization expected by U²-NetP
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

let ortConfigured = false;
let sessionPromise: Promise<ort.InferenceSession> | null = null;
const segmentationCache = new Map<string, ClientAiSegmentationResult>();

function ensureOrtConfigured() {
  if (ortConfigured) return;
  ort.env.wasm.wasmPaths = '/ort/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ortConfigured = true;
}

/**
 * Loads and caches the local pre-trained U²-NetP ONNX session via `onnxruntime-web`.
 */
export function getOnnxSegmentationSession(): Promise<ort.InferenceSession> {
  ensureOrtConfigured();
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(U2NET_MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }).catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

/**
 * Warms up the pre-trained `u2netp.onnx` session inside `onnxruntime-web`
 * as soon as `PartIdentificationProvider` opens or `/identify-part` mounts.
 */
export function preloadClientAiSegmentation(): Promise<void> {
  return getOnnxSegmentationSession()
    .then(() => undefined)
    .catch(() => undefined);
}

function cacheKeyFor(src: string): string {
  return `${src.slice(0, 96)}:${src.slice(-48)}:${src.length}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('client_segmentation_timeout'));
    }, timeoutMs);
    promise.then(
      (val) => {
        window.clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function loadNormalizedRgba(src: string): Promise<{
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    if (/^https?:\/\//i.test(src)) {
      el.crossOrigin = 'anonymous';
    }
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('segment_image_load_failed'));
    el.src = src;
  });

  const natW = img.naturalWidth || img.width || 640;
  const natH = img.naturalHeight || img.height || 640;
  const scale = Math.min(1, MAX_INFERENCE_DIM / Math.max(natW, natH));
  const width = Math.max(32, Math.round(natW * scale));
  const height = Math.max(32, Math.round(natH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('canvas_2d_unavailable');
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const imgData = ctx.getImageData(0, 0, width, height);
  return { width, height, rgba: imgData.data };
}

/**
 * Bilinearly resamples RGBA image into an ImageNet-normalized NCHW float32 tensor [1, 3, 320, 320].
 */
function preprocessRgbaToU2NetTensor(
  rgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
): Float32Array {
  const sz = U2NET_INPUT_SIZE;
  const plane = sz * sz;
  const input = new Float32Array(3 * plane);

  for (let y = 0; y < sz; y++) {
    const fy = (y + 0.5) * (srcH / sz) - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const wy = fy - y0;
    const wyInv = 1 - wy;

    for (let x = 0; x < sz; x++) {
      const fx = (x + 0.5) * (srcW / sz) - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const wx = fx - x0;
      const wxInv = 1 - wx;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const w00 = wxInv * wyInv;
      const w10 = wx * wyInv;
      const w01 = wxInv * wy;
      const w11 = wx * wy;

      const r = (rgba[i00] * w00 + rgba[i10] * w10 + rgba[i01] * w01 + rgba[i11] * w11) / 255;
      const g =
        (rgba[i00 + 1] * w00 +
          rgba[i10 + 1] * w10 +
          rgba[i01 + 1] * w01 +
          rgba[i11 + 1] * w11) /
        255;
      const b =
        (rgba[i00 + 2] * w00 +
          rgba[i10 + 2] * w10 +
          rgba[i01 + 2] * w01 +
          rgba[i11 + 2] * w11) /
        255;

      const idx = y * sz + x;
      input[idx] = (r - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
      input[plane + idx] = (g - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
      input[2 * plane + idx] = (b - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
    }
  }

  return input;
}

/**
 * Normalizes raw 320x320 U²-NetP saliency map and bilinearly upsamples it back to (width, height).
 */
export function postprocessU2NetMask(
  rawScores: ArrayLike<number>,
  targetW: number,
  targetH: number,
): Uint8Array | null {
  const sz = U2NET_INPUT_SIZE;
  const plane = sz * sz;
  if (rawScores.length < plane) return null;

  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < plane; i++) {
    const v = rawScores[i];
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const range = maxV - minV;
  if (maxV < 0.18 || range < 0.12) {
    return null;
  }

  const norm320 = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    norm320[i] = Math.max(0, Math.min(1, (rawScores[i] - minV) / range));
  }

  const alphaMask = new Uint8Array(targetW * targetH);
  for (let y = 0; y < targetH; y++) {
    const fy = (y + 0.5) * (sz / targetH) - 0.5;
    const y0 = Math.max(0, Math.min(sz - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(sz - 1, y0 + 1));
    const wy = fy - y0;
    const wyInv = 1 - wy;

    for (let x = 0; x < targetW; x++) {
      const fx = (x + 0.5) * (sz / targetW) - 0.5;
      const x0 = Math.max(0, Math.min(sz - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(sz - 1, x0 + 1));
      const wx = fx - x0;
      const wxInv = 1 - wx;

      const p =
        norm320[y0 * sz + x0] * wxInv * wyInv +
        norm320[y0 * sz + x1] * wx * wyInv +
        norm320[y1 * sz + x0] * wxInv * wy +
        norm320[y1 * sz + x1] * wx * wy;

      const rawA = Math.round(p * 255);
      // Clean background noise (<22 -> 0) and solidify foreground core (>232 -> 255)
      alphaMask[y * targetW + x] = rawA < 22 ? 0 : rawA > 232 ? 255 : rawA;
    }
  }

  return alphaMask;
}

/**
 * Executes pre-trained `u2netp.onnx` directly via `onnxruntime-web` to isolate
 * industrial parts from backgrounds and render a pure `#FFFFFF` studio cutout.
 */
export async function segmentImageWithClientAi(
  src: string,
): Promise<ClientAiSegmentationResult | null> {
  if (!src) return null;

  const key = cacheKeyFor(src);
  const cached = segmentationCache.get(key);
  if (cached) return cached;

  try {
    const [session, img] = await Promise.all([
      withTimeout(getOnnxSegmentationSession(), MODEL_TIMEOUT_MS),
      loadNormalizedRgba(src),
    ]);

    const { width, height, rgba } = img;
    const inputData = preprocessRgbaToU2NetTensor(rgba, width, height);
    const inputName = session.inputNames[0] || 'input.1';
    const outputName = session.outputNames[0] || '1959';

    const inputTensor = new ort.Tensor('float32', inputData, [
      1,
      3,
      U2NET_INPUT_SIZE,
      U2NET_INPUT_SIZE,
    ]);
    const outputs = await withTimeout(
      session.run({ [inputName]: inputTensor }),
      MODEL_TIMEOUT_MS,
    );
    const outputTensor = outputs[outputName];
    if (!outputTensor?.data) return null;

    const alphaMask = postprocessU2NetMask(
      outputTensor.data as Float32Array,
      width,
      height,
    );
    if (!alphaMask) return null;

    const total = width * height;
    const whiteComposite = new Uint8ClampedArray(total * 4);
    let fgCount = 0;

    for (let i = 0; i < total; i++) {
      const cleanA = alphaMask[i];
      if (cleanA >= 110) fgCount++;
      const o = i * 4;
      const a = cleanA / 255;
      const inv = 1 - a;
      whiteComposite[o] = Math.round(rgba[o] * a + 255 * inv);
      whiteComposite[o + 1] = Math.round(rgba[o + 1] * a + 255 * inv);
      whiteComposite[o + 2] = Math.round(rgba[o + 2] * a + 255 * inv);
      whiteComposite[o + 3] = 255;
    }

    if (fgCount < total * 0.004) {
      return null;
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) return null;
    outCtx.putImageData(new ImageData(whiteComposite, width, height), 0, 0);
    const whiteBgDataUrl = outCanvas.toDataURL('image/jpeg', 0.92);

    const result: ClientAiSegmentationResult = {
      width,
      height,
      alphaMask,
      whiteBgDataUrl,
    };

    if (segmentationCache.size >= 4) {
      const oldestKey = segmentationCache.keys().next().value;
      if (oldestKey) segmentationCache.delete(oldestKey);
    }
    segmentationCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}
