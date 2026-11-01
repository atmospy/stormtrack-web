import type { WindLatest } from '#lib/data/contracts';
import { FrameCache, type LoadedFrame } from './frames';
import type { WindSample } from './field';

/** Holds the frame cache and the currently displayed frame. */
class WindRuntime {
  private cache: FrameCache | null = null;
  current = $state.raw<LoadedFrame | null>(null);
  /** next frame (when cached) for temporal blending, and the blend factor 0..1 */
  next = $state.raw<LoadedFrame | null>(null);
  mix = $state(0);
  error = $state<string | null>(null);
  private token = 0;

  init(latest: WindLatest, base: string): void {
    this.cache?.dispose();
    this.cache = new FrameCache(latest, base);
    this.current = null;
  }

  has(i: number): boolean {
    return this.cache?.has(i) ?? false;
  }

  /** Make frame i current (loads if needed, then warms the next ones). */
  async show(i: number): Promise<void> {
    const cache = this.cache;
    if (!cache) return;
    const my = ++this.token;
    try {
      const f = await cache.load(i);
      if (my !== this.token) return; // a newer request superseded this one
      this.error = null;
      this.current = f;
      this.next = cache.peek(i + 1);
      this.mix = 0;
      cache.preload(i);
      cache.load(i + 1).then((n) => { if (this.current?.index === i) this.next = n; }).catch(() => {});
    } catch (e) {
      if (my === this.token) this.error = (e as Error).message;
    }
  }

  /** CPU sample of the current frame. */
  sample(lon: number, lat: number): WindSample | null {
    return this.current?.field.sample(lon, lat) ?? null;
  }
}

export const windRuntime = new WindRuntime();
