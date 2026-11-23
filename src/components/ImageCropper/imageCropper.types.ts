export type DetectionConfidence = 'high' | 'medium' | 'low';

export type AspectRatioPreset = 'free' | '1:1' | '4:3' | '16:9' | 'original';

export type CropperViewMode = 'detect' | 'original' | 'preview';

export interface CropRect {
  /** Normalized left edge [0..1] */
  x: number;
  /** Normalized top edge [0..1] */
  y: number;
  /** Normalized width (0..1] */
  width: number;
  /** Normalized height (0..1] */
  height: number;
}

export interface DetectedRegion {
  id: string;
  rect: CropRect;
  suggestedCrop: CropRect;
  areaRatio: number;
  confidence: number;
  confidenceLevel: DetectionConfidence;
  aspectRatio: number;
  isElongated: boolean;
  touchesBorder: boolean;
  centroid: { x: number; y: number };
}

export interface BackgroundAnalysis {
  kind: 'transparent' | 'white' | 'gray' | 'dark' | 'textured' | 'mixed';
  borderTransparentRatio: number;
  dominantColors: Array<{ r: number; g: number; b: number; weight: number }>;
  borderVariance: number;
}

export interface ProductDetectionResult {
  confidence: DetectionConfidence;
  score: number;
  regions: DetectedRegion[];
  selectedRegionIndex: number;
  suggestedCrop: CropRect;
  background: BackgroundAnalysis;
  processingMs: number;
  usedFallbackReason?: string;
}

export interface ImageTransformState {
  /** Clockwise rotation in degrees: 0 | 90 | 180 | 270 */
  rotation: 0 | 90 | 180 | 270;
  flipHorizontal: boolean;
  flipVertical: boolean;
  /** -40 to +40 percentage offset */
  brightness: number;
  /** -40 to +40 percentage offset */
  contrast: number;
  /** Viewport zoom 1 to 3 */
  zoom: number;
  /** Viewport normalized pan offset when zoomed */
  panX: number;
  panY: number;
}

export interface ImageCropperConfirmPayload {
  file: File;
  blob: Blob;
  previewUrl: string;
  width: number;
  height: number;
  originalFile: File;
  crop: CropRect;
  transforms: ImageTransformState;
  detection: ProductDetectionResult | null;
}

export interface ImageCropperProps {
  /** Source file chosen by the user. Original File is never mutated. */
  file: File;
  /** Optional title shown in modal header. */
  title?: string;
  /** Optional context hint ('product' | 'category' | 'brand' | 'avatar' | 'logo' | 'document'). */
  context?: 'product' | 'category' | 'brand' | 'avatar' | 'logo' | 'document';
  /** Default aspect ratio preset. */
  defaultAspectRatio?: AspectRatioPreset;
  /** Target output MIME type ('auto' preserves PNG transparency or matches source). */
  outputFormat?: 'auto' | 'image/png' | 'image/jpeg' | 'image/webp';
  /** Max longest edge of exported output in pixels (default 1800). */
  maxOutputDimension?: number;
  /** JPEG/WebP quality 0.1..1 (default 0.92). */
  outputQuality?: number;
  /** Called with processed File & metadata after user clicks 'استفاده از تصویر'. */
  onConfirm: (payload: ImageCropperConfirmPayload) => void | Promise<void>;
  /** Called when user cancels without confirming. */
  onCancel: () => void;
}
