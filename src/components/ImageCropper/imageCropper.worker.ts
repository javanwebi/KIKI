import { detectProductRegionsFromRgba } from './imageDetection';
import type { ProductDetectionResult } from './imageCropper.types';

export interface WorkerDetectRequest {
  requestId: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export interface WorkerDetectResponse {
  requestId: number;
  result?: ProductDetectionResult;
  error?: string;
}

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerDetectRequest>) => void) | null;
  postMessage: (message: WorkerDetectResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = (event: MessageEvent<WorkerDetectRequest>) => {
  const { requestId, width, height, buffer } = event.data;
  try {
    const data = new Uint8ClampedArray(buffer);
    const result = detectProductRegionsFromRgba({ data, width, height });
    ctx.postMessage({ requestId, result });
  } catch (err) {
    ctx.postMessage({
      requestId,
      error: err instanceof Error ? err.message : 'خطا در پردازش محلی تصویر',
    });
  }
};
