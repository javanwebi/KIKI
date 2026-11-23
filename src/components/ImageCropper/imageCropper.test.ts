import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addOptimalPadding,
  applyAspectRatioToCrop,
  cropRectToPixels,
  flipCropRect,
  getPresetNumericRatio,
  resizeOrMoveCropRect,
  rotateCropRect90,
} from './cropGeometry';
import { detectProductRegionsFromRgba } from './imageDetection';
import { resolveOutputMimeType } from './imageProcessing';

function createBuffer(
  width: number,
  height: number,
  fill: [number, number, number, number],
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = fill[3];
  }
  return data;
}

function paintRect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: [number, number, number, number],
): void {
  const minX = Math.max(0, Math.floor(x0));
  const minY = Math.max(0, Math.floor(y0));
  const maxX = Math.min(width - 1, Math.floor(x1));
  const maxY = Math.min(height - 1, Math.floor(y1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = rgba[0];
      data[idx + 1] = rgba[1];
      data[idx + 2] = rgba[2];
      data[idx + 3] = rgba[3];
    }
  }
}

function assertCoversObject(
  crop: { x: number; y: number; width: number; height: number },
  objMinX: number,
  objMinY: number,
  objMaxX: number,
  objMaxY: number,
  imgW: number,
  imgH: number,
): void {
  const px = cropRectToPixels(crop, imgW, imgH);
  assert.ok(px.x <= objMinX, `left edge ${px.x} should be <= ${objMinX}`);
  assert.ok(px.y <= objMinY, `top edge ${px.y} should be <= ${objMinY}`);
  assert.ok(
    px.x + px.width >= objMaxX,
    `right edge ${px.x + px.width} should be >= ${objMaxX}`,
  );
  assert.ok(
    px.y + px.height >= objMaxY,
    `bottom edge ${px.y + px.height} should be >= ${objMaxY}`,
  );
}

test('runs 100% offline with zero network calls and never mutates input pixels', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (() => {
    fetchCalled = true;
    throw new Error('External network call forbidden');
  }) as typeof fetch;

  try {
    const w = 160;
    const h = 120;
    const data = createBuffer(w, h, [252, 252, 252, 255]);
    paintRect(data, w, h, 45, 30, 115, 90, [30, 35, 42, 255]);
    const snapshot = new Uint8ClampedArray(data);

    const res = detectProductRegionsFromRgba({ data, width: w, height: h });
    assert.equal(fetchCalled, false);
    assert.deepEqual(data, snapshot);
    assert.equal(res.confidence, 'high');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('detects product on white background with 8-12% optimal padding', () => {
  const w = 240;
  const h = 200;
  const data = createBuffer(w, h, [255, 255, 255, 255]);
  // Centered industrial pulley
  paintRect(data, w, h, 72, 54, 168, 146, [48, 54, 64, 255]);
  // Orange industrial stripe accent
  paintRect(data, w, h, 88, 92, 152, 108, [229, 107, 30, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.equal(res.background.kind, 'white');
  assert.equal(res.confidence, 'high');
  assert.ok(res.regions.length >= 1);
  assertCoversObject(res.suggestedCrop, 72, 54, 168, 146, w, h);
  assert.ok(res.suggestedCrop.width < 0.65, 'should remove excess empty white margin');
  assert.ok(res.suggestedCrop.height < 0.72, 'should remove excess vertical margin');
});

test('detects bright metallic component on dark background', () => {
  const w = 220;
  const h = 180;
  const data = createBuffer(w, h, [18, 22, 28, 255]);
  paintRect(data, w, h, 65, 50, 155, 130, [205, 212, 220, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.equal(res.background.kind, 'dark');
  assert.equal(res.confidence, 'high');
  assertCoversObject(res.suggestedCrop, 65, 50, 155, 130, w, h);
});

test('detects opaque object on transparent PNG background and preserves PNG output format', () => {
  const w = 200;
  const h = 200;
  const data = createBuffer(w, h, [0, 0, 0, 0]);
  paintRect(data, w, h, 50, 40, 150, 160, [210, 95, 25, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.equal(res.background.kind, 'transparent');
  assert.equal(res.confidence, 'high');
  assertCoversObject(res.suggestedCrop, 50, 40, 150, 160, w, h);

  const mockPngFile = { type: 'image/png', name: 'gear.png' } as File;
  assert.equal(resolveOutputMimeType(mockPngFile, true, 'auto'), 'image/png');
  assert.equal(resolveOutputMimeType(mockPngFile, true, 'image/jpeg'), 'image/png');
});

test('preserves complete long elongated industrial belt without truncating ends', () => {
  const w = 320;
  const h = 160;
  const data = createBuffer(w, h, [248, 249, 251, 255]);
  // Long horizontal belt spanning almost full width (x=18..302, y=68..92)
  paintRect(data, w, h, 18, 68, 302, 92, [28, 30, 34, 255]);
  // Orange belt print markings along length
  paintRect(data, w, h, 40, 76, 80, 82, [229, 107, 30, 255]);
  paintRect(data, w, h, 240, 76, 280, 82, [229, 107, 30, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.ok(res.confidence === 'high' || res.confidence === 'medium');
  assert.equal(res.regions[0]?.isElongated, true);
  assertCoversObject(res.suggestedCrop, 18, 68, 302, 92, w, h);
  assert.ok(res.suggestedCrop.height < 0.45, 'elongated belt crop must stay flat, not forced into square');
});

test('preserves thin mechanical component edges intact', () => {
  const w = 240;
  const h = 180;
  const data = createBuffer(w, h, [245, 245, 247, 255]);
  // Thin vertical steel guide rail / rod (7px wide, 120px tall)
  paintRect(data, w, h, 117, 30, 124, 150, [65, 72, 82, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.ok(res.regions.length >= 1);
  assertCoversObject(res.suggestedCrop, 117, 30, 124, 150, w, h);
});

test('suppresses soft neutral cast shadow beneath product', () => {
  const w = 240;
  const h = 200;
  const data = createBuffer(w, h, [245, 245, 245, 255]);
  // Actual dark red urethane spider coupling at y=40..100
  paintRect(data, w, h, 70, 40, 170, 100, [195, 42, 32, 255]);
  // Soft neutral gray cast shadow underneath at y=102..155 (darker gray, zero chroma)
  paintRect(data, w, h, 74, 102, 166, 155, [215, 215, 215, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.equal(res.confidence, 'high');
  assertCoversObject(res.suggestedCrop, 70, 40, 170, 100, w, h);
  const px = cropRectToPixels(res.suggestedCrop, w, h);
  assert.ok(px.y + px.height < 140, `bottom crop ${px.y + px.height} should ignore cast shadow`);
});

test('detects multiple separated objects so user can select intended product', () => {
  const w = 280;
  const h = 180;
  const data = createBuffer(w, h, [252, 252, 252, 255]);
  paintRect(data, w, h, 24, 48, 92, 132, [34, 45, 65, 255]);
  paintRect(data, w, h, 185, 50, 252, 130, [215, 95, 25, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.ok(res.regions.length >= 2, `expected >= 2 regions, got ${res.regions.length}`);
});

test('falls back cleanly to full image under low-confidence uniform background', () => {
  const w = 180;
  const h = 140;
  const data = createBuffer(w, h, [210, 212, 214, 255]);

  const res = detectProductRegionsFromRgba({ data, width: w, height: h });
  assert.equal(res.confidence, 'low');
  assert.deepEqual(res.suggestedCrop, { x: 0, y: 0, width: 1, height: 1 });
});

test('geometry helpers enforce bounds, aspect ratio locks, rotation, and flips accurately', () => {
  const base = { x: 0.2, y: 0.25, width: 0.4, height: 0.3 };

  // Optimal padding bounds check
  const padded = addOptimalPadding(base, 0.1);
  assert.ok(padded.x >= 0 && padded.y >= 0);
  assert.ok(padded.x + padded.width <= 1 && padded.y + padded.height <= 1);
  assert.ok(padded.x < base.x && padded.width > base.width);

  // Aspect ratio 1:1 on 1000x500 image
  const sqRatio = getPresetNumericRatio('1:1', 1000, 500);
  assert.equal(sqRatio, 1);
  const locked = applyAspectRatioToCrop(base, sqRatio, 1000, 500, base);
  const pxLocked = cropRectToPixels(locked, 1000, 500);
  assert.ok(Math.abs(pxLocked.width - pxLocked.height) <= 2);

  // Move & resize clamping
  const moved = resizeOrMoveCropRect(base, 'move', 0.9, 0.9, null, 1000, 500);
  assert.ok(Math.abs(moved.x + moved.width - 1) < 1e-4);
  assert.ok(Math.abs(moved.y + moved.height - 1) < 1e-4);

  // 4x 90-degree rotations return original rect
  let r = base;
  for (let i = 0; i < 4; i++) r = rotateCropRect90(r, 'cw');
  assert.ok(Math.abs(r.x - base.x) < 1e-5);
  assert.ok(Math.abs(r.y - base.y) < 1e-5);
  assert.ok(Math.abs(r.width - base.width) < 1e-5);
  assert.ok(Math.abs(r.height - base.height) < 1e-5);

  // 2x horizontal/vertical flips return original rect
  const fh = flipCropRect(flipCropRect(base, 'horizontal'), 'horizontal');
  const fv = flipCropRect(flipCropRect(base, 'vertical'), 'vertical');
  assert.deepEqual(fh, base);
  assert.deepEqual(fv, base);
});
