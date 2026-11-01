/// <reference lib="webworker" />
import { packScalar, packVector, type Packed } from './pack';

export interface DecodeRequest {
  id: number;
  url: string;
  kind: 'vector' | 'scalar';
  /** also return the ImageBitmap for GPU upload (false for meteogram-only frames) */
  bitmap: boolean;
}
export type DecodeResponse =
  | { id: number; ok: true; packed: Packed; bitmap?: ImageBitmap }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<DecodeRequest>) => {
  const { id, url, kind, bitmap } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const blob = await res.blob();
    // raw bytes: the PNG encodes data, not colour (no colour management, no premultiplication)
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingEnabled = false;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
    const packed = kind === 'vector' ? packVector(px, bmp.width, bmp.height) : packScalar(px, bmp.width, bmp.height);
    const transfer: Transferable[] = [packed.data.buffer as ArrayBuffer];
    if (bitmap) transfer.push(bmp);
    else bmp.close();
    ctx.postMessage({ id, ok: true, packed, bitmap: bitmap ? bmp : undefined } satisfies DecodeResponse, transfer);
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: (err as Error).message } satisfies DecodeResponse);
  }
};
