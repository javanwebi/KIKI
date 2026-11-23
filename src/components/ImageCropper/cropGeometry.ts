import type { AspectRatioPreset, CropRect } from './imageCropper.types';

export const MIN_CROP_SIZE = 0.04;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function clampCropRect(rect: CropRect, minSize = MIN_CROP_SIZE): CropRect {
  const safeMin = clamp(minSize, 0.01, 0.95);
  let width = clamp(rect.width, safeMin, 1);
  let height = clamp(rect.height, safeMin, 1);
  let x = clamp(rect.x, 0, 1 - width);
  let y = clamp(rect.y, 0, 1 - height);

  if (x + width > 1) width = 1 - x;
  if (y + height > 1) height = 1 - y;

  return {
    x: Number(x.toFixed(6)),
    y: Number(y.toFixed(6)),
    width: Number(Math.max(safeMin, width).toFixed(6)),
    height: Number(Math.max(safeMin, height).toFixed(6)),
  };
}

export function getPresetNumericRatio(
  preset: AspectRatioPreset,
  imageWidth: number,
  imageHeight: number,
): number | null {
  if (preset === 'free') return null;
  if (preset === '1:1') return 1;
  if (preset === '4:3') return 4 / 3;
  if (preset === '16:9') return 16 / 9;
  if (preset === 'original') {
    if (imageWidth > 0 && imageHeight > 0) return imageWidth / imageHeight;
    return 1;
  }
  return null;
}

/**
 * Adds 8-12% proportional padding around a normalized foreground box,
 * clamping safely inside [0, 1] without distorting elongated shapes.
 */
export function addOptimalPadding(
  tightRect: CropRect,
  paddingFraction = 0.1,
  minPaddingFraction = 0.015,
): CropRect {
  const padFrac = clamp(paddingFraction, 0.08, 0.12);
  const padX = Math.max(tightRect.width * padFrac, minPaddingFraction);
  const padY = Math.max(tightRect.height * padFrac, minPaddingFraction);

  const left = Math.max(0, tightRect.x - padX);
  const top = Math.max(0, tightRect.y - padY);
  const right = Math.min(1, tightRect.x + tightRect.width + padX);
  const bottom = Math.min(1, tightRect.y + tightRect.height + padY);

  return clampCropRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

/**
 * Fits or expands a crop rectangle cleanly around its center to satisfy a numeric
 * pixel aspect ratio (widthPx / heightPx), keeping protectedBounds inside if possible.
 */
export function applyAspectRatioToCrop(
  crop: CropRect,
  targetPixelRatio: number | null,
  imageWidth: number,
  imageHeight: number,
  protectedBounds?: CropRect,
): CropRect {
  if (!targetPixelRatio || imageWidth <= 0 || imageHeight <= 0) {
    return clampCropRect(crop);
  }

  // Normalized ratio = pixelRatio * (imageHeight / imageWidth)
  const normRatio = targetPixelRatio * (imageHeight / imageWidth);
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;

  let w = crop.width;
  let h = crop.height;

  if (protectedBounds) {
    // Expand minimally to wrap protectedBounds + satisfy normRatio
    const reqW = Math.max(w, protectedBounds.width);
    const reqH = Math.max(h, protectedBounds.height);
    if (reqW / reqH < normRatio) {
      w = reqH * normRatio;
      h = reqH;
    } else {
      w = reqW;
      h = reqW / normRatio;
    }
  } else {
    const currentNormRatio = w / Math.max(1e-6, h);
    if (currentNormRatio > normRatio) {
      h = w / normRatio;
    } else {
      w = h * normRatio;
    }
  }

  // Scale down proportionally if exceeding image width or height
  if (w > 1) {
    h = h / w;
    w = 1;
  }
  if (h > 1) {
    w = w / h;
    h = 1;
  }

  let x = cx - w / 2;
  let y = cy - h / 2;

  if (protectedBounds) {
    // Shift inside image to keep protectedBounds inside as much as possible
    if (x > protectedBounds.x) x = protectedBounds.x;
    if (x + w < protectedBounds.x + protectedBounds.width) {
      x = protectedBounds.x + protectedBounds.width - w;
    }
    if (y > protectedBounds.y) y = protectedBounds.y;
    if (y + h < protectedBounds.y + protectedBounds.height) {
      y = protectedBounds.y + protectedBounds.height - h;
    }
  }

  x = clamp(x, 0, Math.max(0, 1 - w));
  y = clamp(y, 0, Math.max(0, 1 - h));

  return clampCropRect({ x, y, width: w, height: h });
}

export type CropResizeHandle =
  | 'move'
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w';

/**
 * Computes updated CropRect during drag/resize interaction with optional aspect ratio lock.
 */
export function resizeOrMoveCropRect(
  startRect: CropRect,
  handle: CropResizeHandle,
  dxNorm: number,
  dyNorm: number,
  lockedPixelRatio: number | null,
  imageWidth: number,
  imageHeight: number,
): CropRect {
  if (handle === 'move') {
    return clampCropRect({
      x: clamp(startRect.x + dxNorm, 0, 1 - startRect.width),
      y: clamp(startRect.y + dyNorm, 0, 1 - startRect.height),
      width: startRect.width,
      height: startRect.height,
    });
  }

  let left = startRect.x;
  let top = startRect.y;
  let right = startRect.x + startRect.width;
  let bottom = startRect.y + startRect.height;

  const movesLeft = handle === 'nw' || handle === 'w' || handle === 'sw';
  const movesRight = handle === 'ne' || handle === 'e' || handle === 'se';
  const movesTop = handle === 'nw' || handle === 'n' || handle === 'ne';
  const movesBottom = handle === 'sw' || handle === 's' || handle === 'se';

  if (movesLeft) left = clamp(left + dxNorm, 0, right - MIN_CROP_SIZE);
  if (movesRight) right = clamp(right + dxNorm, left + MIN_CROP_SIZE, 1);
  if (movesTop) top = clamp(top + dyNorm, 0, bottom - MIN_CROP_SIZE);
  if (movesBottom) bottom = clamp(bottom + dyNorm, top + MIN_CROP_SIZE, 1);

  if (!lockedPixelRatio || imageWidth <= 0 || imageHeight <= 0) {
    return clampCropRect({
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
    });
  }

  const normRatio = lockedPixelRatio * (imageHeight / imageWidth);
  let w = right - left;
  let h = bottom - top;

  const isEdgeVertical = handle === 'n' || handle === 's';
  const isEdgeHorizontal = handle === 'e' || handle === 'w';

  if (isEdgeVertical) {
    const cx = (left + right) / 2;
    w = h * normRatio;
    if (w > 1) {
      w = 1;
      h = w / normRatio;
    }
    left = clamp(cx - w / 2, 0, 1 - w);
    right = left + w;
    if (movesTop) top = bottom - h;
    else bottom = top + h;
  } else if (isEdgeHorizontal) {
    const cy = (top + bottom) / 2;
    h = w / normRatio;
    if (h > 1) {
      h = 1;
      w = h * normRatio;
    }
    top = clamp(cy - h / 2, 0, 1 - h);
    bottom = top + h;
    if (movesLeft) left = right - w;
    else right = left + w;
  } else {
    // Corner resize: preserve anchor opposite corner
    const maxW = movesLeft ? right : 1 - left;
    const maxH = movesTop ? bottom : 1 - top;

    if (w / Math.max(1e-6, h) > normRatio) {
      h = w / normRatio;
    } else {
      w = h * normRatio;
    }

    if (w > maxW) {
      w = maxW;
      h = w / normRatio;
    }
    if (h > maxH) {
      h = maxH;
      w = h * normRatio;
    }

    if (movesLeft) left = right - w;
    else right = left + w;

    if (movesTop) top = bottom - h;
    else bottom = top + h;
  }

  return clampCropRect({
    x: left,
    y: top,
    width: Math.max(MIN_CROP_SIZE, right - left),
    height: Math.max(MIN_CROP_SIZE, bottom - top),
  });
}

/**
 * Maps a normalized CropRect through a 90-degree CW/CCW rotation or axis flip
 * so the user's manual/detected crop stays aligned with the product after orientation changes.
 */
export function rotateCropRect90(rect: CropRect, direction: 'cw' | 'ccw'): CropRect {
  if (direction === 'cw') {
    return clampCropRect({
      x: 1 - (rect.y + rect.height),
      y: rect.x,
      width: rect.height,
      height: rect.width,
    });
  }
  return clampCropRect({
    x: rect.y,
    y: 1 - (rect.x + rect.width),
    width: rect.height,
    height: rect.width,
  });
}

export function flipCropRect(rect: CropRect, axis: 'horizontal' | 'vertical'): CropRect {
  if (axis === 'horizontal') {
    return clampCropRect({
      x: 1 - (rect.x + rect.width),
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }
  return clampCropRect({
    x: rect.x,
    y: 1 - (rect.y + rect.height),
    width: rect.width,
    height: rect.height,
  });
}

/**
 * Converts normalized CropRect to integer pixel bounds inside target width/height.
 */
export function cropRectToPixels(
  crop: CropRect,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const safeCrop = clampCropRect(crop, 0.01);
  const x = Math.max(0, Math.min(imageWidth - 1, Math.round(safeCrop.x * imageWidth)));
  const y = Math.max(0, Math.min(imageHeight - 1, Math.round(safeCrop.y * imageHeight)));
  const width = Math.max(1, Math.min(imageWidth - x, Math.round(safeCrop.width * imageWidth)));
  const height = Math.max(1, Math.min(imageHeight - y, Math.round(safeCrop.height * imageHeight)));
  return { x, y, width, height };
}
