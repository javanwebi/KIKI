import { cropRectToPixels } from './cropGeometry';
import type { CropRect, ImageTransformState } from './imageCropper.types';

export interface LoadedBitmapSource {
  bitmap: ImageBitmap;
  naturalWidth: number;
  naturalHeight: number;
  hasTransparency: boolean;
  close: () => void;
}

function createCanvasElement(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  isOffscreen: boolean;
} {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      return { canvas, ctx, isOffscreen: true };
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('مرورگر امکان ایجاد بوم پردازش تصویر (Canvas 2D) را ندارد.');
  }
  return { canvas, ctx, isOffscreen: false };
}

function createDisplayCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('امکان ایجاد Canvas خروجی وجود ندارد.');
  }
  return { canvas, ctx };
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => {
        if (!blob) reject(new Error('تبدیل خروجی تصویر به فایل ناموفق بود.'));
        else resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

/**
 * Loads an image File safely using createImageBitmap() (respecting EXIF orientation
 * where supported) with Image element fallback, and samples border alpha.
 */
export async function loadImageSource(file: File): Promise<LoadedBitmapSource> {
  let bitmap: ImageBitmap;
  if (typeof createImageBitmap === 'function') {
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      bitmap = await createImageBitmap(file);
    }
  } else {
    // Fallback via Image element if needed in older environments
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('بارگذاری تصویر انتخاب‌شده امکان‌پذیر نیست.'));
        el.src = objectUrl;
      });
      const { canvas, ctx } = createDisplayCanvas(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, 0, 0);
      bitmap = await createImageBitmap(canvas);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  const naturalWidth = bitmap.width;
  const naturalHeight = bitmap.height;

  // Quick alpha scan on a tiny thumbnail to check transparency without blocking main thread
  let hasTransparency = false;
  try {
    const thumbSize = 64;
    const { ctx } = createCanvasElement(thumbSize, thumbSize);
    ctx.clearRect(0, 0, thumbSize, thumbSize);
    ctx.drawImage(bitmap, 0, 0, thumbSize, thumbSize);
    const data = ctx.getImageData(0, 0, thumbSize, thumbSize).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 245) {
        hasTransparency = true;
        break;
      }
    }
  } catch {
    hasTransparency = file.type === 'image/png';
  }

  return {
    bitmap,
    naturalWidth,
    naturalHeight,
    hasTransparency,
    close: () => {
      try {
        bitmap.close();
      } catch {
        // already closed
      }
    },
  };
}

export function getOrientedDimensions(
  naturalWidth: number,
  naturalHeight: number,
  rotation: 0 | 90 | 180 | 270,
): { width: number; height: number } {
  if (rotation === 90 || rotation === 270) {
    return { width: naturalHeight, height: naturalWidth };
  }
  return { width: naturalWidth, height: naturalHeight };
}

/**
 * Renders the currently oriented (rotated + flipped + brightness/contrast) bitmap
 * into a display-ready canvas or extracts a downscaled RGBA buffer for Web Worker CV.
 */
export function drawOrientedBitmap(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  targetWidth: number,
  targetHeight: number,
  transforms: Pick<ImageTransformState, 'rotation' | 'flipHorizontal' | 'flipVertical' | 'brightness' | 'contrast'>,
  applyToneFilter = false,
): void {
  ctx.save();
  ctx.clearRect(0, 0, targetWidth, targetHeight);

  if (applyToneFilter && (transforms.brightness !== 0 || transforms.contrast !== 0)) {
    const b = Math.max(0.4, 1 + transforms.brightness / 100);
    const c = Math.max(0.4, 1 + transforms.contrast / 100);
    if ('filter' in ctx) {
      ctx.filter = `brightness(${b.toFixed(2)}) contrast(${c.toFixed(2)})`;
    }
  }

  ctx.translate(targetWidth / 2, targetHeight / 2);
  ctx.rotate((transforms.rotation * Math.PI) / 180);
  ctx.scale(transforms.flipHorizontal ? -1 : 1, transforms.flipVertical ? -1 : 1);

  const drawW =
    transforms.rotation === 90 || transforms.rotation === 270 ? targetHeight : targetWidth;
  const drawH =
    transforms.rotation === 90 || transforms.rotation === 270 ? targetWidth : targetHeight;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
}

/**
 * Safely downscales large images into an analysis RGBA buffer (max edge ~360px)
 * suitable for sub-35ms Web Worker segmentation without memory bloat.
 */
export function extractAnalysisImageData(
  bitmap: ImageBitmap,
  transforms: Pick<ImageTransformState, 'rotation' | 'flipHorizontal' | 'flipVertical'>,
  maxAnalysisEdge = 360,
): { width: number; height: number; buffer: ArrayBuffer } {
  const oriented = getOrientedDimensions(bitmap.width, bitmap.height, transforms.rotation);
  const scale = Math.min(1, maxAnalysisEdge / Math.max(oriented.width, oriented.height));
  const width = Math.max(8, Math.round(oriented.width * scale));
  const height = Math.max(8, Math.round(oriented.height * scale));

  const { ctx } = createCanvasElement(width, height);
  drawOrientedBitmap(
    ctx,
    bitmap,
    width,
    height,
    {
      ...transforms,
      brightness: 0,
      contrast: 0,
    },
    false,
  );
  const imgData = ctx.getImageData(0, 0, width, height);
  const copy = new Uint8ClampedArray(imgData.data);
  return {
    width,
    height,
    buffer: copy.buffer,
  };
}

function buildOutputFileName(originalName: string, mimeType: string): string {
  const dotIdx = originalName.lastIndexOf('.');
  const stem = (dotIdx > 0 ? originalName.slice(0, dotIdx) : originalName)
    .replace(/[^\w\u0600-\u06FF.-]+/g, '-')
    .slice(0, 60) || 'image';
  const ext =
    mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return `${stem}-cropped.${ext}`;
}

export function resolveOutputMimeType(
  sourceFile: File,
  hasTransparency: boolean,
  requestedFormat: 'auto' | 'image/png' | 'image/jpeg' | 'image/webp' = 'auto',
): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (requestedFormat !== 'auto') {
    if (requestedFormat === 'image/jpeg' && hasTransparency) {
      return 'image/png';
    }
    return requestedFormat;
  }
  if (hasTransparency || sourceFile.type === 'image/png') {
    return 'image/png';
  }
  if (sourceFile.type === 'image/webp') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/**
 * Generates clean final cropped/adjusted image File & Blob without overlays,
 * watermarks, bounding boxes, or labels.
 */
export async function exportCroppedImageFile(options: {
  sourceFile: File;
  bitmap: ImageBitmap;
  crop: CropRect;
  transforms: ImageTransformState;
  hasTransparency: boolean;
  outputFormat?: 'auto' | 'image/png' | 'image/jpeg' | 'image/webp';
  maxOutputDimension?: number;
  outputQuality?: number;
}): Promise<{ file: File; blob: Blob; width: number; height: number }> {
  const {
    sourceFile,
    bitmap,
    crop,
    transforms,
    hasTransparency,
    outputFormat = 'auto',
    maxOutputDimension = 1800,
    outputQuality = 0.92,
  } = options;

  const oriented = getOrientedDimensions(bitmap.width, bitmap.height, transforms.rotation);
  const pixelRect = cropRectToPixels(crop, oriented.width, oriented.height);

  // Render oriented source at full or bounded resolution
  const orientedScale = Math.min(1, 2800 / Math.max(oriented.width, oriented.height));
  const fullCanvasW = Math.max(1, Math.round(oriented.width * orientedScale));
  const fullCanvasH = Math.max(1, Math.round(oriented.height * orientedScale));

  const { canvas: orientedCanvas, ctx: orientedCtx } = createCanvasElement(
    fullCanvasW,
    fullCanvasH,
  );
  drawOrientedBitmap(orientedCtx, bitmap, fullCanvasW, fullCanvasH, transforms, true);

  // If browser lacks ctx.filter support (e.g. older OffscreenCanvas), apply manual brightness/contrast fallback
  const hasFilterSupport = typeof (orientedCtx as { filter?: unknown }).filter === 'string';
  if (!hasFilterSupport && (transforms.brightness !== 0 || transforms.contrast !== 0)) {
    const imgData = orientedCtx.getImageData(0, 0, fullCanvasW, fullCanvasH);
    const d = imgData.data;
    const bOffset = (transforms.brightness / 100) * 255;
    const cFactor = Math.max(0.4, 1 + transforms.contrast / 100);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.max(0, Math.min(255, (d[i] + bOffset - 128) * cFactor + 128));
      d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] + bOffset - 128) * cFactor + 128));
      d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] + bOffset - 128) * cFactor + 128));
    }
    orientedCtx.putImageData(imgData, 0, 0);
  }

  const sx = Math.max(0, Math.round(pixelRect.x * orientedScale));
  const sy = Math.max(0, Math.round(pixelRect.y * orientedScale));
  const sw = Math.max(1, Math.min(fullCanvasW - sx, Math.round(pixelRect.width * orientedScale)));
  const sh = Math.max(1, Math.min(fullCanvasH - sy, Math.round(pixelRect.height * orientedScale)));

  const outScale = Math.min(1, maxOutputDimension / Math.max(pixelRect.width, pixelRect.height));
  const outW = Math.max(1, Math.round(pixelRect.width * outScale));
  const outH = Math.max(1, Math.round(pixelRect.height * outScale));

  const mimeType = resolveOutputMimeType(sourceFile, hasTransparency, outputFormat);
  const { canvas: outCanvas, ctx: outCtx } = createCanvasElement(outW, outH);

  if (mimeType === 'image/jpeg') {
    outCtx.fillStyle = '#FFFFFF';
    outCtx.fillRect(0, 0, outW, outH);
  } else {
    outCtx.clearRect(0, 0, outW, outH);
  }

  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(orientedCanvas, sx, sy, sw, sh, 0, 0, outW, outH);

  let blob = await canvasToBlob(outCanvas, mimeType, outputQuality);

  // Enforce safe < 8MB upload size cap by stepping down JPEG/WebP quality or dimensions if huge PNG
  if (blob.size > 7.5 * 1024 * 1024) {
    if (mimeType === 'image/png' && Math.max(outW, outH) > 1400) {
      const shrink = 1400 / Math.max(outW, outH);
      const smallW = Math.max(1, Math.round(outW * shrink));
      const smallH = Math.max(1, Math.round(outH * shrink));
      const { canvas: smallCanvas, ctx: smallCtx } = createCanvasElement(smallW, smallH);
      smallCtx.imageSmoothingEnabled = true;
      smallCtx.imageSmoothingQuality = 'high';
      smallCtx.drawImage(outCanvas, 0, 0, smallW, smallH);
      blob = await canvasToBlob(smallCanvas, mimeType, 0.92);
    } else if (mimeType !== 'image/png') {
      blob = await canvasToBlob(outCanvas, mimeType, 0.82);
    }
  }

  const outName = buildOutputFileName(sourceFile.name, mimeType);
  const outFile = new File([blob], outName, {
    type: mimeType,
    lastModified: Date.now(),
  });

  return { file: outFile, blob, width: outW, height: outH };
}

/**
 * Renders a live lightweight preview canvas/DataURL for 'تصویر اصلی' or 'پیشنمایش نهایی'.
 */
export function renderPreviewDataUrl(options: {
  bitmap: ImageBitmap;
  crop: CropRect;
  transforms: ImageTransformState;
  mode: 'original' | 'preview';
  hasTransparency: boolean;
  maxPreviewEdge?: number;
}): string {
  const {
    bitmap,
    crop,
    transforms,
    mode,
    hasTransparency,
    maxPreviewEdge = 720,
  } = options;

  const oriented = getOrientedDimensions(bitmap.width, bitmap.height, transforms.rotation);

  if (mode === 'original') {
    const scale = Math.min(1, maxPreviewEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const { canvas, ctx } = createDisplayCanvas(w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL(hasTransparency ? 'image/png' : 'image/jpeg', 0.9);
  }

  const pixelRect = cropRectToPixels(crop, oriented.width, oriented.height);
  const cropScale = Math.min(1, maxPreviewEdge / Math.max(pixelRect.width, pixelRect.height));
  const outW = Math.max(1, Math.round(pixelRect.width * cropScale));
  const outH = Math.max(1, Math.round(pixelRect.height * cropScale));

  const tempScale = Math.min(1, 1080 / Math.max(oriented.width, oriented.height));
  const tmpW = Math.max(1, Math.round(oriented.width * tempScale));
  const tmpH = Math.max(1, Math.round(oriented.height * tempScale));
  const { canvas: tmpCanvas, ctx: tmpCtx } = createDisplayCanvas(tmpW, tmpH);
  drawOrientedBitmap(tmpCtx, bitmap, tmpW, tmpH, transforms, true);

  const sx = Math.max(0, Math.round(pixelRect.x * tempScale));
  const sy = Math.max(0, Math.round(pixelRect.y * tempScale));
  const sw = Math.max(1, Math.min(tmpW - sx, Math.round(pixelRect.width * tempScale)));
  const sh = Math.max(1, Math.min(tmpH - sy, Math.round(pixelRect.height * tempScale)));

  const { canvas, ctx } = createDisplayCanvas(outW, outH);
  if (!hasTransparency) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);
  } else {
    ctx.clearRect(0, 0, outW, outH);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmpCanvas, sx, sy, sw, sh, 0, 0, outW, outH);

  return canvas.toDataURL(hasTransparency ? 'image/png' : 'image/jpeg', 0.9);
}
