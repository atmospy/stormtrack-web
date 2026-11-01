import type { IsobarRequest, IsobarResponse } from './isobarsWorker.js';
import type { IsobarOptions, IsobarResult, ScalarFrameMeta, ScalarImageSource } from './types.js';

export interface IsobarWorker {
  /**
   * Decode `image` and contour it off the main thread. The image is structured-cloned (the caller keeps its
   * ImageBitmap) unless `transfer` is true, which detaches an ImageBitmap for zero-copy.
   */
  isobars(image: ScalarImageSource, meta: ScalarFrameMeta, opts?: IsobarOptions & { transfer?: boolean }): Promise<IsobarResult>;
  terminate(): void;
}

/** Spawn the isobar worker (Vite/webpack-compatible `new Worker(new URL(...), { type: 'module' })`). */
export function createIsobarWorker(): IsobarWorker {
  const worker = new Worker(new URL('./isobarsWorker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map<number, { resolve: (r: IsobarResult) => void; reject: (e: Error) => void }>();
  worker.onmessage = (e: MessageEvent<IsobarResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if ('error' in e.data) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`scalar-layer isobar worker failed: ${e.message}`));
    pending.clear();
  };
  return {
    isobars(image, meta, opts = {}) {
      const { transfer, ...rest } = opts;
      const id = ++seq;
      return new Promise<IsobarResult>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const msg: IsobarRequest = { id, image, meta, opts: rest };
        const canTransfer = transfer && typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
        worker.postMessage(msg, canTransfer ? [image as ImageBitmap] : []);
      });
    },
    terminate() {
      worker.terminate();
      for (const p of pending.values()) p.reject(new Error('terminated'));
      pending.clear();
    },
  };
}
