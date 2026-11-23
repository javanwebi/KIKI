import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  clamp,
  type CropResizeHandle,
  resizeOrMoveCropRect,
} from './cropGeometry';
import { drawOrientedBitmap, getOrientedDimensions } from './imageProcessing';
import type {
  CropRect,
  CropperViewMode,
  DetectedRegion,
  ImageTransformState,
} from './imageCropper.types';

interface ImageCropperCanvasProps {
  bitmap: ImageBitmap;
  hasTransparency: boolean;
  crop: CropRect;
  transforms: ImageTransformState;
  lockedPixelRatio: number | null;
  viewMode: CropperViewMode;
  previewDataUrl: string | null;
  regions: DetectedRegion[];
  selectedRegionIndex: number;
  showDetectedOverlay: boolean;
  isDetecting: boolean;
  onCropChange: (next: CropRect) => void;
  onTransformsChange: (updater: (prev: ImageTransformState) => ImageTransformState) => void;
  onSelectRegion: (index: number) => void;
}

const HANDLES: Array<{
  id: CropResizeHandle;
  cursor: string;
  posClass: string;
  dotClass: string;
}> = [
  {
    id: 'nw',
    cursor: 'nwse-resize',
    posClass: '-top-3 -left-3',
    dotClass: 'w-3.5 h-3.5 rounded-full',
  },
  {
    id: 'n',
    cursor: 'ns-resize',
    posClass: '-top-3 left-1/2 -translate-x-1/2',
    dotClass: 'w-6 h-2.5 rounded-full',
  },
  {
    id: 'ne',
    cursor: 'nesw-resize',
    posClass: '-top-3 -right-3',
    dotClass: 'w-3.5 h-3.5 rounded-full',
  },
  {
    id: 'e',
    cursor: 'ew-resize',
    posClass: 'top-1/2 -translate-y-1/2 -right-3',
    dotClass: 'w-2.5 h-6 rounded-full',
  },
  {
    id: 'se',
    cursor: 'nwse-resize',
    posClass: '-bottom-3 -right-3',
    dotClass: 'w-3.5 h-3.5 rounded-full',
  },
  {
    id: 's',
    cursor: 'ns-resize',
    posClass: '-bottom-3 left-1/2 -translate-x-1/2',
    dotClass: 'w-6 h-2.5 rounded-full',
  },
  {
    id: 'sw',
    cursor: 'nesw-resize',
    posClass: '-bottom-3 -left-3',
    dotClass: 'w-3.5 h-3.5 rounded-full',
  },
  {
    id: 'w',
    cursor: 'ew-resize',
    posClass: 'top-1/2 -translate-y-1/2 -left-3',
    dotClass: 'w-2.5 h-6 rounded-full',
  },
];

export const ImageCropperCanvas: React.FC<ImageCropperCanvasProps> = ({
  bitmap,
  hasTransparency,
  crop,
  transforms,
  lockedPixelRatio,
  viewMode,
  previewDataUrl,
  regions,
  selectedRegionIndex,
  showDetectedOverlay,
  isDetecting,
  onCropChange,
  onTransformsChange,
  onSelectRegion,
}) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [stageSize, setStageSize] = useState({ width: 520, height: 400 });

  const oriented = getOrientedDimensions(
    bitmap.width,
    bitmap.height,
    transforms.rotation,
  );

  // Observe available stage dimensions so oriented image fits cleanly without clipping
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) {
        setStageSize({
          width: Math.floor(rect.width - 24),
          height: Math.floor(rect.height - 24),
        });
      }
    };
    update();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Fitted un-zoomed display dimensions in pixels inside stage
  const fitScale = Math.min(
    stageSize.width / Math.max(1, oriented.width),
    stageSize.height / Math.max(1, oriented.height),
    1.5,
  );
  const displayW = Math.max(120, Math.round(oriented.width * fitScale));
  const displayH = Math.max(120, Math.round(oriented.height * fitScale));

  // Render oriented bitmap into visible canvas smoothly
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewMode === 'preview') return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.round(displayW * dpr));
    const targetH = Math.max(1, Math.round(displayH * dpr));

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const drawTransforms =
      viewMode === 'original'
        ? {
            rotation: 0 as const,
            flipHorizontal: false,
            flipVertical: false,
            brightness: 0,
            contrast: 0,
          }
        : transforms;

    drawOrientedBitmap(
      ctx,
      bitmap,
      targetW,
      targetH,
      drawTransforms,
      viewMode === 'detect',
    );
  }, [bitmap, displayW, displayH, transforms, viewMode]);

  const dragRef = useRef<{
    type: CropResizeHandle | 'pan';
    startX: number;
    startY: number;
    startCrop: CropRect;
    startPanX: number;
    startPanY: number;
    frameWidth: number;
    frameHeight: number;
  } | null>(null);

  const startInteraction = useCallback(
    (
      e: React.PointerEvent,
      type: CropResizeHandle | 'pan',
    ) => {
      if (viewMode !== 'detect') return;
      e.preventDefault();
      e.stopPropagation();

      const frameEl = frameRef.current;
      const frameRect = frameEl?.getBoundingClientRect();
      const frameWidth = frameRect?.width || displayW * transforms.zoom;
      const frameHeight = frameRect?.height || displayH * transforms.zoom;

      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // ignore synthetic pointer events without active pointerId
      }

      dragRef.current = {
        type,
        startX: e.clientX,
        startY: e.clientY,
        startCrop: crop,
        startPanX: transforms.panX,
        startPanY: transforms.panY,
        frameWidth: Math.max(1, frameWidth),
        frameHeight: Math.max(1, frameHeight),
      };
    },
    [crop, displayH, displayW, transforms.panX, transforms.panY, transforms.zoom, viewMode],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();

      const dxPx = e.clientX - drag.startX;
      const dyPx = e.clientY - drag.startY;

      if (drag.type === 'pan') {
        const maxPan = Math.max(0, (transforms.zoom - 1) * 0.45);
        const nextPanX = clamp(drag.startPanX + dxPx / drag.frameWidth, -maxPan, maxPan);
        const nextPanY = clamp(drag.startPanY + dyPx / drag.frameHeight, -maxPan, maxPan);
        onTransformsChange((prev) => ({ ...prev, panX: nextPanX, panY: nextPanY }));
        return;
      }

      const dxNorm = dxPx / drag.frameWidth;
      const dyNorm = dyPx / drag.frameHeight;

      const nextCrop = resizeOrMoveCropRect(
        drag.startCrop,
        drag.type,
        dxNorm,
        dyNorm,
        lockedPixelRatio,
        oriented.width,
        oriented.height,
      );
      onCropChange(nextCrop);
    },
    [lockedPixelRatio, onCropChange, onTransformsChange, oriented.height, oriented.width, transforms.zoom],
  );

  const endInteraction = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    dragRef.current = null;
  }, []);

  // Mouse wheel zoom support inside canvas stage
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (viewMode !== 'detect') return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.12 : -0.12;
      onTransformsChange((prev) => {
        const nextZoom = Number(clamp(prev.zoom + delta, 1, 3).toFixed(2));
        return {
          ...prev,
          zoom: nextZoom,
          panX: nextZoom <= 1 ? 0 : prev.panX,
          panY: nextZoom <= 1 ? 0 : prev.panY,
        };
      });
    },
    [onTransformsChange, viewMode],
  );

  if (viewMode === 'preview') {
    return (
      <div
        ref={stageRef}
        className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-[#E5E9EF] bg-[#F5F7FA] p-4"
      >
        <div
          className={
            'relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-xl border border-slate-200 shadow-sm ' +
            (hasTransparency
              ? 'bg-[conic-gradient(#e2e8f0_90deg,#ffffff_90deg_180deg,#e2e8f0_180deg_270deg,#ffffff_270deg)] bg-[length:16px_16px]'
              : 'bg-white')
          }
        >
          {previewDataUrl ? (
            <img
              src={previewDataUrl}
              alt="پیشنمایش نهایی"
              className="max-h-[420px] max-w-full object-contain sm:max-h-[500px]"
            />
          ) : (
            <div className="px-8 py-16 text-xs text-slate-500">
              در حال آماده‌سازی پیش‌نمایش...
            </div>
          )}
        </div>
      </div>
    );
  }

  const fallbackBrightness = `brightness(${Math.max(0.4, 1 + transforms.brightness / 100).toFixed(2)}) contrast(${Math.max(0.4, 1 + transforms.contrast / 100).toFixed(2)})`;

  return (
    <div
      ref={stageRef}
      dir="ltr"
      onWheel={handleWheel}
      onPointerDown={(e) => {
        if (viewMode === 'detect' && transforms.zoom > 1) {
          startInteraction(e, 'pan');
        }
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={endInteraction}
      onPointerCancel={endInteraction}
      className="relative flex h-full w-full select-none items-center justify-center overflow-hidden rounded-2xl border border-[#E5E9EF] bg-[#F3F5F8] p-3"
    >
      {/* Zoomed / Panned Image Frame */}
      <div
        ref={frameRef}
        style={{
          width: `${displayW}px`,
          height: `${displayH}px`,
          transform:
            viewMode === 'detect'
              ? `translate(${transforms.panX * displayW}px, ${transforms.panY * displayH}px) scale(${transforms.zoom})`
              : undefined,
          transformOrigin: 'center center',
        }}
        className={
          'relative shrink-0 overflow-hidden rounded-lg border border-slate-300/80 shadow-sm ' +
          (hasTransparency
            ? 'bg-[conic-gradient(#e5e7eb_90deg,#ffffff_90deg_180deg,#e5e7eb_180deg_270deg,#ffffff_270deg)] bg-[length:14px_14px]'
            : 'bg-white')
        }
      >
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            height: '100%',
            filter: viewMode === 'detect' ? fallbackBrightness : undefined,
          }}
          className="block h-full w-full"
        />

        {/* Detected Bounding Box Overlay(s) */}
        {showDetectedOverlay &&
          regions.map((region, idx) => {
            const isSelected = idx === selectedRegionIndex;
            const r = region.rect;
            return (
              <button
                key={region.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRegion(idx);
                }}
                title={`محدوده تشخیص داده‌شده ${idx + 1}`}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.width * 100}%`,
                  height: `${r.height * 100}%`,
                }}
                className={
                  'absolute z-10 rounded transition-colors cursor-pointer ' +
                  (isSelected
                    ? 'border-2 border-dashed border-emerald-500 bg-emerald-400/5'
                    : 'border border-dashed border-amber-500/90 bg-amber-400/10 hover:bg-amber-400/20')
                }
              >
                {regions.length > 1 && (
                  <span
                    className={
                      'absolute -top-5 right-0 rounded px-1.5 py-0.5 text-[10px] font-bold shadow-xs ' +
                      (isSelected
                        ? 'bg-emerald-600 text-white'
                        : 'bg-amber-500 text-white')
                    }
                  >
                    #{idx + 1}
                  </span>
                )}
              </button>
            );
          })}

        {/* Interactive Crop Box & Scrim (only in detect/edit mode) */}
        {viewMode === 'detect' && (
          <div
            onPointerDown={(e) => startInteraction(e, 'move')}
            style={{
              left: `${crop.x * 100}%`,
              top: `${crop.y * 100}%`,
              width: `${crop.width * 100}%`,
              height: `${crop.height * 100}%`,
              boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.42)',
              touchAction: 'none',
            }}
            className="absolute z-20 cursor-move border-2 border-[#E56B1E]"
          >
            {/* Rule of thirds guides */}
            <span className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/55" />
            <span className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/55" />
            <span className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/55" />
            <span className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/55" />

            {/* 8 Drag & Resize Handles with large touch hit zones */}
            {HANDLES.map((h) => (
              <div
                key={h.id}
                role="slider"
                aria-label={`تغییر اندازه برش ${h.id}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(crop.width * 100)}
                tabIndex={0}
                onPointerDown={(e) => startInteraction(e, h.id)}
                style={{ cursor: h.cursor, touchAction: 'none' }}
                className={
                  'absolute z-30 flex h-7 w-7 items-center justify-center ' +
                  h.posClass
                }
              >
                <span
                  className={
                    'block border border-[#E56B1E] bg-white shadow-sm ' +
                    h.dotClass
                  }
                />
              </div>
            ))}
          </div>
        )}

        {/* Scanning overlay while Web Worker runs */}
        {isDetecting && (
          <div
            dir="rtl"
            className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-white/70 backdrop-blur-[1px]"
          >
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-[#E56B1E] border-t-transparent" />
            <span className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[#55565A] shadow-xs border border-slate-200">
              در حال تشخیص خودکار محصول...
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
