import { PLAYBACK } from '#lib/config';
import type { WindLatest } from '#lib/data/contracts';
import { windFrameUrl } from '#lib/data/load';
import { WindField } from './field';

export interface LoadedFrame {
  index: number;
  image: ImageBitmap;
  field: WindField;
}

/** Lazy, LRU-cached frame loader with de-duplicated in-flight requests. */
export class FrameCache {
  private cache = new Map<number, LoadedFrame>();
  private inflight = new Map<number, Promise<LoadedFrame>>();

  constructor(
    private readonly latest: WindLatest,
    private readonly base: string
  ) {}

  has(i: number): boolean {
    return this.cache.has(i);
  }

  peek(i: number): LoadedFrame | null {
    return this.cache.get(i) ?? null;
  }

  load(i: number): Promise<LoadedFrame> {
    const hit = this.cache.get(i);
    if (hit) {
      this.cache.delete(i);
      this.cache.set(i, hit);
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(i);
    if (pending) return pending;
    const frame = this.latest.frames[i];
    if (!frame) return Promise.reject(new Error(`no frame ${i}`));
    const p = (async () => {
      const res = await fetch(windFrameUrl(this.base, frame.png));
      if (!res.ok) throw new Error(`wind frame ${frame.png}: HTTP ${res.status}`);
      const blob = await res.blob();
      // raw bytes: no colour management, no premultiplication (the PNG encodes data, not colour)
      const image = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const loaded: LoadedFrame = { index: i, image, field: WindField.fromImage(this.latest.image, image) };
      this.cache.set(i, loaded);
      while (this.cache.size > PLAYBACK.cacheSize) {
        const oldest = this.cache.keys().next().value as number;
        this.cache.delete(oldest);
      }
      return loaded;
    })().finally(() => this.inflight.delete(i));
    this.inflight.set(i, p);
    return p;
  }

  /** Warm the next frames without blocking; errors are swallowed (they surface on use). */
  preload(from: number): void {
    for (let k = 1; k <= PLAYBACK.preloadAhead; k++) {
      const i = from + k;
      if (i < this.latest.frames.length && !this.cache.has(i)) this.load(i).catch(() => {});
    }
  }

  dispose(): void {
    this.cache.clear();
  }
}
