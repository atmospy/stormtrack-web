import { packScalar, packVector, type Packed } from './pack';
import type { DecodeRequest, DecodeResponse } from './decode.worker';

export interface Decoded {
  packed: Packed;
  bitmap?: ImageBitmap;
}

const POOL = 3;
let workers: Worker[] | null = null;
let rr = 0;
let seq = 0;
const waiting = new Map<number, { resolve: (d: Decoded) => void; reject: (e: Error) => void }>();

function pool(): Worker[] | null {
  if (workers) return workers;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  try {
    workers = Array.from({ length: POOL }, () => {
      const w = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<DecodeResponse>) => {
        const r = e.data;
        const p = waiting.get(r.id);
        if (!p) return;
        waiting.delete(r.id);
        if (r.ok) p.resolve({ packed: r.packed, bitmap: r.bitmap });
        else p.reject(new Error(r.error));
      };
      w.onerror = () => {
        // a crashed worker must not strand its callers: fail them so the main-thread path can take over
        for (const [id, p] of waiting) { waiting.delete(id); p.reject(new Error('decode worker crashed')); }
        workers = null;
      };
      return w;
    });
  } catch {
    workers = null;
  }
  return workers;
}

/** Main-thread fallback (same result, but the pixel read blocks the thread briefly). */
async function decodeHere(url: string, kind: 'vector' | 'scalar', wantBitmap: boolean): Promise<Decoded> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  g.imageSmoothingEnabled = false;
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
  const packed = kind === 'vector' ? packVector(px, bmp.width, bmp.height) : packScalar(px, bmp.width, bmp.height);
  if (!wantBitmap) bmp.close();
  return { packed, bitmap: wantBitmap ? bmp : undefined };
}

/** Fetch + decode a frame PNG off the main thread (worker pool), falling back to the main thread. */
export async function decodeFrame(url: string, kind: 'vector' | 'scalar', bitmap: boolean): Promise<Decoded> {
  const ws = pool();
  if (ws) {
    try {
      return await new Promise<Decoded>((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        ws[rr++ % ws.length]!.postMessage({ id, url, kind, bitmap } satisfies DecodeRequest);
      });
    } catch (e) {
      if (!/HTTP \d+/.test((e as Error).message)) return decodeHere(url, kind, bitmap);
      throw e;
    }
  }
  return decodeHere(url, kind, bitmap);
}
