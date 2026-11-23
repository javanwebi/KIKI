import { useCallback, useEffect, useRef, useState } from 'react';
import { detectProductRegionsFromRgba } from './imageDetection';
import { extractAnalysisImageData } from './imageProcessing';
import type { ImageTransformState, ProductDetectionResult } from './imageCropper.types';
import type { WorkerDetectRequest, WorkerDetectResponse } from './imageCropper.worker';

export interface UseImageDetectionResult {
  detection: ProductDetectionResult | null;
  isDetecting: boolean;
  error: string | null;
  runDetection: (
    bitmap: ImageBitmap,
    transforms: Pick<ImageTransformState, 'rotation' | 'flipHorizontal' | 'flipVertical'>,
  ) => Promise<ProductDetectionResult | null>;
}

/**
 * Manages off-main-thread Web Worker object detection with automatic cancellation
 * of stale requests and graceful fallback if Web Workers are unavailable.
 */
export function useImageDetection(): UseImageDetectionResult {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const pendingRejectRef = useRef<Map<number, (reason?: unknown) => void>>(new Map());
  const [detection, setDetection] = useState<ProductDetectionResult | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      pendingRejectRef.current.clear();
    };
  }, []);

  const getOrCreateWorker = useCallback((): Worker | null => {
    if (typeof Worker === 'undefined') return null;
    if (workerRef.current) return workerRef.current;
    try {
      const worker = new Worker(new URL('./imageCropper.worker.ts', import.meta.url), {
        type: 'module',
      });
      workerRef.current = worker;
      return worker;
    } catch {
      return null;
    }
  }, []);

  const runDetection = useCallback(
    async (
      bitmap: ImageBitmap,
      transforms: Pick<ImageTransformState, 'rotation' | 'flipHorizontal' | 'flipVertical'>,
    ): Promise<ProductDetectionResult | null> => {
      const requestId = ++requestIdRef.current;
      setIsDetecting(true);
      setError(null);

      try {
        const { width, height, buffer } = extractAnalysisImageData(bitmap, transforms, 360);
        const worker = getOrCreateWorker();

        let result: ProductDetectionResult;
        if (worker) {
          result = await new Promise<ProductDetectionResult>((resolve, reject) => {
            const onMessage = (event: MessageEvent<WorkerDetectResponse>) => {
              if (event.data.requestId !== requestId) return;
              cleanup();
              if (event.data.error || !event.data.result) {
                reject(new Error(event.data.error || 'خطا در تحلیل محلی تصویر'));
              } else {
                resolve(event.data.result);
              }
            };
            const onError = () => {
              cleanup();
              // Fallback safely to local detection if worker script fails
              try {
                const copy = new Uint8ClampedArray(buffer);
                resolve(detectProductRegionsFromRgba({ data: copy, width, height }));
              } catch (err) {
                reject(err);
              }
            };
            const cleanup = () => {
              worker.removeEventListener('message', onMessage);
              worker.removeEventListener('error', onError);
              pendingRejectRef.current.delete(requestId);
            };

            pendingRejectRef.current.set(requestId, reject);
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);

            const msg: WorkerDetectRequest = {
              requestId,
              width,
              height,
              buffer,
            };
            worker.postMessage(msg, [buffer]);
          });
        } else {
          // Async microtask fallback if Worker isn't supported in environment
          await new Promise((r) => setTimeout(r, 0));
          result = detectProductRegionsFromRgba({
            data: new Uint8ClampedArray(buffer),
            width,
            height,
          });
        }

        if (requestId !== requestIdRef.current) {
          return null;
        }

        setDetection(result);
        setIsDetecting(false);
        return result;
      } catch (err) {
        if (requestId !== requestIdRef.current) return null;
        const msg = err instanceof Error ? err.message : 'تحلیل خودکار تصویر ناموفق بود.';
        setError(msg);
        setIsDetecting(false);
        return null;
      }
    },
    [getOrCreateWorker],
  );

  return {
    detection,
    isDetecting,
    error,
    runDetection,
  };
}
