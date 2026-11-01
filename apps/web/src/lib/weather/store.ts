import type { WeatherField, WeatherModel } from '#lib/data/weather';
import { decodeFrame } from './decoder';
import { packedBytes, type Packed } from './pack';

export interface FrameRef { base: string; model: WeatherModel; field: WeatherField; index: number }
export const frameKey = (r: FrameRef): string => `${r.model.model}@${r.model.run}/${r.field.slug}/${r.index}`;
export const frameUrl = (r: FrameRef): string => `${r.base}/${r.field.frames[r.index]!.png}`;

export interface StoreLimits { packedBytes: number; bitmaps: number }
export const DEFAULT_LIMITS: StoreLimits = { packedBytes: 320 * 1024 * 1024, bitmaps: 16 };

export type Decode = typeof decodeFrame;

/**
 * Two LRU caches over decoded frames, with de-duplicated in-flight requests:
 *  - packed CPU grids (byte-budgeted) feed readout, arrows and the meteogram;
 *  - ImageBitmaps (count-limited) feed the GPU layers.
 * Run-stamped frame URLs are immutable, so a key never needs invalidating.
 */
export class FrameStore {
  private packed = new Map<string, Packed>();
  private bitmaps = new Map<string, ImageBitmap>();
  private inflight = new Map<string, Promise<void>>();
  private bytes = 0;
  /** how many frames were decoded (for tests/telemetry) */
  decodes = 0;

  constructor(private readonly limits: StoreLimits = DEFAULT_LIMITS, private readonly decode: Decode = decodeFrame) {}

  hasPacked(r: FrameRef): boolean { return this.packed.has(frameKey(r)); }
  hasBitmap(r: FrameRef): boolean { return this.bitmaps.has(frameKey(r)); }
  peekPacked(r: FrameRef): Packed | null { return this.touch(this.packed, frameKey(r)); }
  peekBitmap(r: FrameRef): ImageBitmap | null { return this.touch(this.bitmaps, frameKey(r)); }
  get size() { return { packed: this.packed.size, bitmaps: this.bitmaps.size, bytes: this.bytes }; }

  private touch<T>(m: Map<string, T>, k: string): T | null {
    const v = m.get(k);
    if (v === undefined) return null;
    m.delete(k);
    m.set(k, v);
    return v;
  }

  /** Ensure the frame is decoded; resolves when packed (and, if asked, the bitmap) is cached. */
  async ensure(r: FrameRef, needBitmap: boolean): Promise<void> {
    const k = frameKey(r);
    if (this.packed.has(k) && (!needBitmap || this.bitmaps.has(k))) return;
    const fk = needBitmap ? `${k}#b` : k;
    let p = this.inflight.get(fk) ?? (needBitmap ? undefined : this.inflight.get(`${k}#b`));
    if (!p) {
      p = (async () => {
        this.decodes++;
        const d = await this.decode(frameUrl(r), r.field.kind, needBitmap);
        if (!this.packed.has(k)) {
          this.packed.set(k, d.packed);
          this.bytes += packedBytes(d.packed);
          this.evict();
        }
        if (d.bitmap) {
          this.bitmaps.set(k, d.bitmap);
          while (this.bitmaps.size > this.limits.bitmaps) this.bitmaps.delete(this.bitmaps.keys().next().value as string);
        }
      })().finally(() => this.inflight.delete(fk));
      this.inflight.set(fk, p);
    }
    return p;
  }

  private evict(): void {
    while (this.bytes > this.limits.packedBytes && this.packed.size > 1) {
      const k = this.packed.keys().next().value as string;
      this.bytes -= packedBytes(this.packed.get(k)!);
      this.packed.delete(k);
    }
  }

  clear(): void {
    this.packed.clear();
    this.bitmaps.clear();
    this.bytes = 0;
  }
}
