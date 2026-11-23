import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  FlipHorizontal2,
  FlipVertical2,
  Info,
  Layers,
  Maximize2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScanSearch,
  Sliders,
  Sparkles,
  Sun,
  Contrast,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  applyAspectRatioToCrop,
  clampCropRect,
  cropRectToPixels,
  flipCropRect,
  getPresetNumericRatio,
  rotateCropRect90,
} from './cropGeometry';
import { ImageCropperCanvas } from './ImageCropperCanvas';
import {
  exportCroppedImageFile,
  getOrientedDimensions,
  loadImageSource,
  renderPreviewDataUrl,
  type LoadedBitmapSource,
} from './imageProcessing';
import type {
  AspectRatioPreset,
  CropRect,
  CropperViewMode,
  ImageCropperProps,
  ImageTransformState,
} from './imageCropper.types';
import { useImageDetection } from './useImageDetection';
import { toPersianDigits } from '../../utils/formatters';

const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

const DEFAULT_TRANSFORMS: ImageTransformState = {
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
  brightness: 0,
  contrast: 0,
  zoom: 1,
  panX: 0,
  panY: 0,
};

const ASPECT_OPTIONS: Array<{ id: AspectRatioPreset; label: string }> = [
  { id: 'free', label: 'برش آزاد' },
  { id: '1:1', label: '۱:۱' },
  { id: '4:3', label: '۴:۳' },
  { id: '16:9', label: '۱۶:۹' },
  { id: 'original', label: 'نسبت اصلی' },
];

export const ImageCropper: React.FC<ImageCropperProps> = ({
  file,
  title,
  context = 'product',
  defaultAspectRatio = 'free',
  outputFormat = 'auto',
  maxOutputDimension = 1800,
  outputQuality = 0.92,
  onConfirm,
  onCancel,
}) => {
  const [source, setSource] = useState<LoadedBitmapSource | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropRect>(DEFAULT_CROP);
  const [aspectPreset, setAspectPreset] = useState<AspectRatioPreset>(defaultAspectRatio);
  const [transforms, setTransforms] = useState<ImageTransformState>(DEFAULT_TRANSFORMS);
  const [viewMode, setViewMode] = useState<CropperViewMode>('detect');
  const [showDetectedOverlay, setShowDetectedOverlay] = useState(true);
  const [selectedRegionIndex, setSelectedRegionIndex] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const objectUrlsRef = useRef<string[]>([]);
  const { detection, isDetecting, error: detectionError, runDetection } = useImageDetection();

  const applySuggestedCropForPreset = useCallback(
    (
      baseRect: CropRect,
      preset: AspectRatioPreset,
      bitmap: ImageBitmap,
      rot: 0 | 90 | 180 | 270,
    ) => {
      const dims = getOrientedDimensions(bitmap.width, bitmap.height, rot);
      const ratio = getPresetNumericRatio(preset, dims.width, dims.height);
      if (!ratio) {
        return clampCropRect(baseRect);
      }
      return applyAspectRatioToCrop(baseRect, ratio, dims.width, dims.height, baseRect);
    },
    [],
  );

  // Load image locally with ImageBitmap and run initial off-thread product detection
  useEffect(() => {
    let active = true;
    let loadedRef: LoadedBitmapSource | null = null;

    setLoadError(null);
    setExportError(null);
    setTransforms(DEFAULT_TRANSFORMS);
    setAspectPreset(defaultAspectRatio);
    setViewMode('detect');
    setSelectedRegionIndex(0);

    loadImageSource(file)
      .then(async (loaded) => {
        if (!active) {
          loaded.close();
          return;
        }
        loadedRef = loaded;
        setSource(loaded);

        const initialRatio = getPresetNumericRatio(
          defaultAspectRatio,
          loaded.naturalWidth,
          loaded.naturalHeight,
        );
        const fallbackInitialCrop = initialRatio
          ? applyAspectRatioToCrop(
              DEFAULT_CROP,
              initialRatio,
              loaded.naturalWidth,
              loaded.naturalHeight,
            )
          : DEFAULT_CROP;
        setCrop(fallbackInitialCrop);

        const res = await runDetection(loaded.bitmap, DEFAULT_TRANSFORMS);
        if (!active || !res) return;

        setSelectedRegionIndex(res.selectedRegionIndex);
        if (res.confidence !== 'low') {
          setCrop(
            applySuggestedCropForPreset(
              res.suggestedCrop,
              defaultAspectRatio,
              loaded.bitmap,
              0,
            ),
          );
        } else {
          setCrop(fallbackInitialCrop);
        }
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(
          err instanceof Error ? err.message : 'خواندن فایل تصویر ناموفق بود.',
        );
      });

    return () => {
      active = false;
      if (loadedRef) loadedRef.close();
    };
  }, [file, defaultAspectRatio, runDetection, applySuggestedCropForPreset]);

  // Clean up any created temporary Object URLs on unmount
  useEffect(() => {
    return () => {
      for (const u of objectUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      objectUrlsRef.current = [];
    };
  }, []);

  // Escape key closes safely
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExporting) {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isExporting, onCancel]);

  const orientedDims = useMemo(() => {
    if (!source) return { width: 1, height: 1 };
    return getOrientedDimensions(
      source.naturalWidth,
      source.naturalHeight,
      transforms.rotation,
    );
  }, [source, transforms.rotation]);

  const lockedPixelRatio = useMemo(
    () => getPresetNumericRatio(aspectPreset, orientedDims.width, orientedDims.height),
    [aspectPreset, orientedDims.height, orientedDims.width],
  );

  const outputPixelDims = useMemo(
    () => cropRectToPixels(crop, orientedDims.width, orientedDims.height),
    [crop, orientedDims.height, orientedDims.width],
  );

  // Compute live 'تصویر اصلی' or 'پیشنمایش نهایی' data URL when viewing compare modes
  const comparePreviewUrl = useMemo(() => {
    if (!source || viewMode === 'detect') return null;
    return renderPreviewDataUrl({
      bitmap: source.bitmap,
      crop,
      transforms,
      mode: viewMode === 'original' ? 'original' : 'preview',
      hasTransparency: source.hasTransparency,
    });
  }, [crop, source, transforms, viewMode]);

  const handleAspectChange = (preset: AspectRatioPreset) => {
    setAspectPreset(preset);
    if (!source) return;
    const ratio = getPresetNumericRatio(preset, orientedDims.width, orientedDims.height);
    if (ratio) {
      setCrop((prev) =>
        applyAspectRatioToCrop(prev, ratio, orientedDims.width, orientedDims.height),
      );
    }
    setViewMode('detect');
  };

  const handleRotate = (direction: 'cw' | 'ccw') => {
    if (!source) return;
    const step = direction === 'cw' ? 90 : 270;
    const nextRot = ((transforms.rotation + step) % 360) as 0 | 90 | 180 | 270;
    const nextTransforms = { ...transforms, rotation: nextRot };
    setTransforms(nextTransforms);
    setCrop((prev) => rotateCropRect90(prev, direction));
    void runDetection(source.bitmap, nextTransforms).then((res) => {
      if (res) setSelectedRegionIndex(res.selectedRegionIndex);
    });
  };

  const handleFlip = (axis: 'horizontal' | 'vertical') => {
    if (!source) return;
    const nextTransforms = {
      ...transforms,
      flipHorizontal:
        axis === 'horizontal' ? !transforms.flipHorizontal : transforms.flipHorizontal,
      flipVertical:
        axis === 'vertical' ? !transforms.flipVertical : transforms.flipVertical,
    };
    setTransforms(nextTransforms);
    setCrop((prev) => flipCropRect(prev, axis));
    void runDetection(source.bitmap, nextTransforms).then((res) => {
      if (res) setSelectedRegionIndex(res.selectedRegionIndex);
    });
  };

  const handleRetryDetection = async () => {
    if (!source || isDetecting) return;
    setViewMode('detect');
    const res = await runDetection(source.bitmap, transforms);
    if (!res) return;
    setSelectedRegionIndex(res.selectedRegionIndex);
    if (res.confidence !== 'low') {
      setCrop(
        applySuggestedCropForPreset(
          res.suggestedCrop,
          aspectPreset,
          source.bitmap,
          transforms.rotation,
        ),
      );
    } else {
      setCrop(
        applySuggestedCropForPreset(
          DEFAULT_CROP,
          aspectPreset,
          source.bitmap,
          transforms.rotation,
        ),
      );
    }
  };

  const handleSelectRegion = (index: number) => {
    if (!source || !detection?.regions[index]) return;
    setSelectedRegionIndex(index);
    const chosen = detection.regions[index];
    setCrop(
      applySuggestedCropForPreset(
        chosen.suggestedCrop,
        aspectPreset,
        source.bitmap,
        transforms.rotation,
      ),
    );
    setViewMode('detect');
  };

  const handleResetAll = () => {
    if (!source) return;
    setTransforms(DEFAULT_TRANSFORMS);
    setAspectPreset(defaultAspectRatio);
    setViewMode('detect');
    void runDetection(source.bitmap, DEFAULT_TRANSFORMS).then((res) => {
      if (res && res.confidence !== 'low') {
        setSelectedRegionIndex(res.selectedRegionIndex);
        setCrop(
          applySuggestedCropForPreset(
            res.suggestedCrop,
            defaultAspectRatio,
            source.bitmap,
            0,
          ),
        );
      } else {
        setCrop(
          applySuggestedCropForPreset(
            DEFAULT_CROP,
            defaultAspectRatio,
            source.bitmap,
            0,
          ),
        );
      }
    });
  };

  const handleConfirmClick = async () => {
    if (!source || isExporting) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const exported = await exportCroppedImageFile({
        sourceFile: file,
        bitmap: source.bitmap,
        crop,
        transforms,
        hasTransparency: source.hasTransparency,
        outputFormat,
        maxOutputDimension,
        outputQuality,
      });

      const previewUrl = URL.createObjectURL(exported.blob);
      objectUrlsRef.current.push(previewUrl);

      await onConfirm({
        file: exported.file,
        blob: exported.blob,
        previewUrl,
        width: exported.width,
        height: exported.height,
        originalFile: file,
        crop,
        transforms,
        detection,
      });
    } catch (err) {
      setExportError(
        err instanceof Error ? err.message : 'آماده‌سازی تصویر نهایی با خطا مواجه شد.',
      );
    } finally {
      setIsExporting(false);
    }
  };

  const confidenceBanner = useMemo(() => {
    if (isDetecting) {
      return {
        tone: 'bg-slate-50 border-slate-200 text-[#55565A]',
        icon: <ScanSearch className="h-4 w-4 shrink-0 text-[#E56B1E]" />,
        title: 'در حال تحلیل تصویر...',
        text: 'تشخیص خودکار محصول به‌صورت کاملاً محلی در مرورگر شما در حال اجراست.',
      };
    }
    if (!detection) return null;
    if (detection.confidence === 'high') {
      return {
        tone: 'bg-emerald-50/90 border-emerald-200 text-emerald-900',
        icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />,
        title: 'محدوده محصول با دقت بالا شناسایی شد',
        text: 'در صورت نیاز می‌توانید کادر برش را به‌صورت دستی اصلاح کنید.',
      };
    }
    if (detection.confidence === 'medium') {
      return {
        tone: 'bg-amber-50 border-amber-200 text-amber-900',
        icon: <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />,
        title: 'محدوده پیشنهادی شناسایی شد؛ لطفاً بررسی کنید',
        text: 'مرز پس‌زمینه نزدیک به قطعه است. پیش از تأیید، محدوده تشخیص داده‌شده را کنترل یا اصلاح نمایید.',
      };
    }
    return {
      tone: 'bg-slate-100 border-slate-200 text-[#55565A]',
      icon: <Info className="h-4 w-4 shrink-0 text-[#55565A]" />,
      title: 'حالت کنترل دستی فعال است',
      text:
        detection.usedFallbackReason ||
        'تشخیص خودکار با اطمینان کافی انجام نشد؛ تصویر اصلی نمایش داده شده است و می‌توانید برش را دستی تنظیم کنید.',
    };
  }, [detection, isDetecting]);

  const contextSubtitle =
    context === 'avatar'
      ? 'تصویر پروفایل کاربری'
      : context === 'logo' || context === 'brand'
        ? 'لوگو و نشان سازمانی'
        : context === 'category'
          ? 'تصویر دسته‌بندی کاتالوگ'
          : context === 'document'
            ? 'تصویر مدرک ارسالی'
            : 'تصویر صنعتی / محصول';

  return (
    <div
      dir="rtl"
      role="dialog"
      aria-modal="true"
      aria-label={title || 'تشخیص خودکار محصول و ویرایش برش'}
      className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-900/45 p-0 backdrop-blur-[2px] sm:p-4"
      style={{ fontFamily: 'Vazirmatn, Tahoma, sans-serif' }}
    >
      <div className="flex h-[100dvh] w-full flex-col overflow-hidden bg-[#FAFBFC] text-[#222E3E] shadow-2xl sm:h-[min(92dvh,860px)] sm:max-w-6xl sm:rounded-2xl sm:border sm:border-[#E5E9EF]">
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#E5E9EF] bg-white px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#FFF2E8] text-[#E56B1E] border border-[#F5D3BA]">
              <ScanSearch className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-sm font-black text-[#55565A] sm:text-base">
                  {title || 'تشخیص خودکار محصول'}
                </h2>
                <span className="text-xs font-medium text-slate-400">·</span>
                <span className="text-xs font-bold text-[#E56B1E]">{contextSubtitle}</span>
              </div>
              <p dir="ltr" className="mt-0.5 truncate text-right text-[11px] text-slate-500">
                {file.name}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onCancel}
            disabled={isExporting}
            aria-label="بستن ویرایشگر تصویر"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#E5E9EF] bg-white text-[#55565A] hover:bg-slate-50 cursor-pointer disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Body */}
        {loadError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-6 py-5 text-sm font-bold text-rose-800 max-w-md">
              {loadError}
            </div>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-xs font-bold text-[#55565A] hover:bg-slate-50 cursor-pointer"
            >
              بازگشت
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
            {/* Main Interactive Stage */}
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
              {/* View Switcher & Detection Retry Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  role="tablist"
                  aria-label="حالت نمایش تصویر"
                  className="inline-flex items-center gap-1 rounded-xl border border-[#E5E9EF] bg-white p-1"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === 'detect'}
                    onClick={() => setViewMode('detect')}
                    className={
                      'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ' +
                      (viewMode === 'detect'
                        ? 'bg-[#E56B1E] text-white'
                        : 'text-[#55565A] hover:bg-slate-100')
                    }
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>اصلاح محدوده برش</span>
                  </button>

                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === 'original'}
                    onClick={() => setViewMode('original')}
                    className={
                      'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ' +
                      (viewMode === 'original'
                        ? 'bg-[#55565A] text-white'
                        : 'text-[#55565A] hover:bg-slate-100')
                    }
                  >
                    <Layers className="h-3.5 w-3.5" />
                    <span>تصویر اصلی</span>
                  </button>

                  <button
                    type="button"
                    role="tab"
                    aria-selected={viewMode === 'preview'}
                    onClick={() => setViewMode('preview')}
                    className={
                      'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ' +
                      (viewMode === 'preview'
                        ? 'bg-[#E56B1E] text-white'
                        : 'text-[#55565A] hover:bg-slate-100')
                    }
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>پیشنمایش نهایی</span>
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-pressed={showDetectedOverlay}
                    onClick={() => setShowDetectedOverlay((v) => !v)}
                    className={
                      'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ' +
                      (showDetectedOverlay
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                        : 'border-[#E5E9EF] bg-white text-[#55565A] hover:bg-slate-50')
                    }
                  >
                    <ScanSearch className="h-3.5 w-3.5" />
                    <span>محدوده تشخیص دادهشده</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleRetryDetection()}
                    disabled={!source || isDetecting}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#F5D3BA] bg-[#FFF5EE] px-3 py-2 text-xs font-bold text-[#C65A16] hover:bg-[#FFEAD9] whitespace-nowrap cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw
                      className={'h-3.5 w-3.5 ' + (isDetecting ? 'animate-spin' : '')}
                    />
                    <span>تلاش مجدد برای تشخیص</span>
                  </button>
                </div>
              </div>

              {/* Confidence Guidance & Multi-Object Selector */}
              {confidenceBanner && (
                <div
                  role="status"
                  className={
                    'flex flex-col gap-2 rounded-xl border px-3.5 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between ' +
                    confidenceBanner.tone
                  }
                >
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5">{confidenceBanner.icon}</span>
                    <div>
                      <strong className="font-black">{confidenceBanner.title}</strong>
                      <span className="mx-1.5 text-slate-400">·</span>
                      <span className="leading-5">{confidenceBanner.text}</span>
                    </div>
                  </div>

                  {detection && detection.regions.length > 1 && (
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <span className="text-[11px] font-bold">انتخاب قطعه:</span>
                      {detection.regions.map((reg, idx) => (
                        <button
                          key={reg.id}
                          type="button"
                          onClick={() => handleSelectRegion(idx)}
                          className={
                            'rounded-lg px-2.5 py-1 text-[11px] font-bold cursor-pointer transition-colors ' +
                            (idx === selectedRegionIndex
                              ? 'bg-[#E56B1E] text-white'
                              : 'bg-white border border-slate-300 text-[#55565A] hover:border-[#E56B1E]')
                          }
                        >
                          محصول {toPersianDigits(idx + 1)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {detectionError && (
                <div
                  role="alert"
                  className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs font-bold text-amber-800"
                >
                  {detectionError}
                </div>
              )}

              {/* Interactive Canvas Area */}
              <div className="min-h-[260px] flex-1 sm:min-h-[340px]">
                {source ? (
                  <ImageCropperCanvas
                    bitmap={source.bitmap}
                    hasTransparency={source.hasTransparency}
                    crop={crop}
                    transforms={transforms}
                    lockedPixelRatio={lockedPixelRatio}
                    viewMode={viewMode}
                    previewDataUrl={comparePreviewUrl}
                    regions={detection?.regions || []}
                    selectedRegionIndex={selectedRegionIndex}
                    showDetectedOverlay={showDetectedOverlay}
                    isDetecting={isDetecting}
                    onCropChange={setCrop}
                    onTransformsChange={setTransforms}
                    onSelectRegion={handleSelectRegion}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center rounded-2xl border border-[#E5E9EF] bg-white text-xs text-slate-500">
                    در حال آماده‌سازی تصویر...
                  </div>
                )}
              </div>
            </div>

            {/* Right / Bottom Controls Panel */}
            <aside className="flex max-h-[38dvh] w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-[#E5E9EF] bg-white p-4 lg:max-h-none lg:w-80 lg:border-t-0 lg:border-r">
              {/* Aspect Ratio Presets */}
              <section className="space-y-2">
                <div className="flex items-center justify-between text-xs font-black text-[#55565A]">
                  <span className="flex items-center gap-1.5">
                    <Maximize2 className="h-3.5 w-3.5 text-[#E56B1E]" />
                    نسبت تصویر
                  </span>
                  <span className="font-mono text-[11px] font-bold text-slate-500 tabular-nums">
                    {toPersianDigits(outputPixelDims.width)} ×{' '}
                    {toPersianDigits(outputPixelDims.height)}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 lg:grid-cols-3">
                  {ASPECT_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleAspectChange(opt.id)}
                      aria-pressed={aspectPreset === opt.id}
                      className={
                        'min-h-[40px] rounded-xl border px-2 py-1.5 text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ' +
                        (aspectPreset === opt.id
                          ? 'border-[#E56B1E] bg-[#FFF2E8] text-[#C65A16]'
                          : 'border-[#E5E9EF] bg-[#FAFBFC] text-[#55565A] hover:bg-slate-100')
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </section>

              {/* Rotate & Flip */}
              <section className="space-y-2 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between text-xs font-black text-[#55565A]">
                  <span className="flex items-center gap-1.5">
                    <RotateCw className="h-3.5 w-3.5 text-[#E56B1E]" />
                    چرخش تصویر
                  </span>
                  <span className="font-mono text-[11px] font-bold text-slate-500 tabular-nums">
                    {toPersianDigits(transforms.rotation)}°
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleRotate('ccw')}
                    title="چرخش ۹۰ درجه پادساعتگرد"
                    className="flex min-h-[42px] items-center justify-center rounded-xl border border-[#E5E9EF] bg-[#FAFBFC] text-[#55565A] hover:border-[#E56B1E] hover:text-[#E56B1E] cursor-pointer"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRotate('cw')}
                    title="چرخش ۹۰ درجه ساعتگرد"
                    className="flex min-h-[42px] items-center justify-center rounded-xl border border-[#E5E9EF] bg-[#FAFBFC] text-[#55565A] hover:border-[#E56B1E] hover:text-[#E56B1E] cursor-pointer"
                  >
                    <RotateCw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFlip('horizontal')}
                    aria-pressed={transforms.flipHorizontal}
                    title="قرینه افقی"
                    className={
                      'flex min-h-[42px] items-center justify-center rounded-xl border cursor-pointer ' +
                      (transforms.flipHorizontal
                        ? 'border-[#E56B1E] bg-[#FFF2E8] text-[#E56B1E]'
                        : 'border-[#E5E9EF] bg-[#FAFBFC] text-[#55565A] hover:border-[#E56B1E]')
                    }
                  >
                    <FlipHorizontal2 className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFlip('vertical')}
                    aria-pressed={transforms.flipVertical}
                    title="قرینه عمودی"
                    className={
                      'flex min-h-[42px] items-center justify-center rounded-xl border cursor-pointer ' +
                      (transforms.flipVertical
                        ? 'border-[#E56B1E] bg-[#FFF2E8] text-[#E56B1E]'
                        : 'border-[#E5E9EF] bg-[#FAFBFC] text-[#55565A] hover:border-[#E56B1E]')
                    }
                  >
                    <FlipVertical2 className="h-4 w-4" />
                  </button>
                </div>
              </section>

              {/* Zoom, Brightness & Contrast */}
              <section className="space-y-3 border-t border-slate-100 pt-3">
                <div className="flex items-center gap-1.5 text-xs font-black text-[#55565A]">
                  <Sliders className="h-3.5 w-3.5 text-[#E56B1E]" />
                  <span>تنظیمات دقیق نمایش</span>
                </div>

                {/* Zoom */}
                <label className="block space-y-1.5">
                  <span className="flex items-center justify-between text-xs font-bold text-[#55565A]">
                    <span className="flex items-center gap-1.5">
                      <ZoomIn className="h-3.5 w-3.5 text-slate-400" />
                      بزرگنمایی
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums" dir="ltr">
                      {transforms.zoom.toFixed(1)}×
                    </span>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.1}
                    value={transforms.zoom}
                    onChange={(e) => {
                      const z = Number(e.target.value);
                      setTransforms((prev) => ({
                        ...prev,
                        zoom: z,
                        panX: z <= 1 ? 0 : prev.panX,
                        panY: z <= 1 ? 0 : prev.panY,
                      }));
                    }}
                    className="w-full accent-[#E56B1E] cursor-pointer"
                  />
                </label>

                {/* Brightness */}
                <label className="block space-y-1.5">
                  <span className="flex items-center justify-between text-xs font-bold text-[#55565A]">
                    <span className="flex items-center gap-1.5">
                      <Sun className="h-3.5 w-3.5 text-slate-400" />
                      روشنایی
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums" dir="ltr">
                      {transforms.brightness > 0 ? `+${transforms.brightness}` : transforms.brightness}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={-35}
                    max={35}
                    step={1}
                    value={transforms.brightness}
                    onChange={(e) =>
                      setTransforms((prev) => ({
                        ...prev,
                        brightness: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[#E56B1E] cursor-pointer"
                  />
                </label>

                {/* Contrast */}
                <label className="block space-y-1.5">
                  <span className="flex items-center justify-between text-xs font-bold text-[#55565A]">
                    <span className="flex items-center gap-1.5">
                      <Contrast className="h-3.5 w-3.5 text-slate-400" />
                      کنتراست
                    </span>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums" dir="ltr">
                      {transforms.contrast > 0 ? `+${transforms.contrast}` : transforms.contrast}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={-35}
                    max={35}
                    step={1}
                    value={transforms.contrast}
                    onChange={(e) =>
                      setTransforms((prev) => ({
                        ...prev,
                        contrast: Number(e.target.value),
                      }))
                    }
                    className="w-full accent-[#E56B1E] cursor-pointer"
                  />
                </label>
              </section>

              {/* Reset & Local Info */}
              <div className="mt-auto space-y-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={handleResetAll}
                  className="flex min-h-[40px] w-full items-center justify-center gap-1.5 rounded-xl border border-[#E5E9EF] bg-[#FAFBFC] px-3 py-2 text-xs font-bold text-[#55565A] hover:bg-slate-100 cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>بازگردانی به حالت تشخیص خودکار</span>
                </button>
                <p className="text-[11px] leading-5 text-slate-500">
                  پردازش و تشخیص به‌صورت ۱۰۰٪ محلی روی مرورگر شما انجام می‌شود و بدون ارسال تصویر به سرویس‌های خارجی عمل می‌کند.
                </p>
              </div>
            </aside>
          </div>
        )}

        {/* Footer */}
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[#E5E9EF] bg-white px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3 text-xs text-slate-500">
            {source && (
              <span>
                ابعاد نهایی:{' '}
                <strong className="font-mono text-[#55565A] tabular-nums" dir="ltr">
                  {outputPixelDims.width}×{outputPixelDims.height}px
                </strong>
                {source.hasTransparency && (
                  <>
                    <span className="mx-1.5">·</span>
                    <span>حفظ پس‌زمینه شفاف PNG</span>
                  </>
                )}
              </span>
            )}
            {exportError && (
              <span role="alert" className="font-bold text-rose-600">
                {exportError}
              </span>
            )}
          </div>

          <div className="flex w-full items-center justify-end gap-2.5 sm:w-auto">
            <button
              type="button"
              onClick={onCancel}
              disabled={isExporting}
              className="min-h-[44px] flex-1 rounded-xl border border-[#E5E9EF] bg-white px-5 py-2.5 text-xs font-bold text-[#55565A] hover:bg-slate-50 cursor-pointer sm:flex-none disabled:opacity-40"
            >
              انصراف
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmClick()}
              disabled={!source || isExporting || !!loadError}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-2 rounded-xl bg-[#E56B1E] px-6 py-2.5 text-xs font-black text-white shadow-sm hover:bg-[#C95210] cursor-pointer sm:flex-none disabled:opacity-40"
            >
              <Check className="h-4 w-4" />
              <span>{isExporting ? 'در حال آماده‌سازی...' : 'استفاده از تصویر'}</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};
