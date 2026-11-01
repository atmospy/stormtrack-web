import type { ScalarField, VectorField } from '#lib/data/weather';
import { app } from '#lib/stores/app.svelte';
import { buildMeteogram, meteogramFrames, SERIES_KEYS, type Meteogram, type SeriesKey } from './series';
import { weather } from './runtime.svelte';
import { frameKey, type FrameRef } from './store';

const CONCURRENCY = 4;

/**
 * Click-anywhere meteogram, computed entirely from frames: no API calls. Frames needed (only for the series that are
 * switched on) are decoded off-thread into the shared FrameStore; once cached, a new point is an instant lookup.
 */
export class MeteoState {
  point = $state<{ lon: number; lat: number } | null>(null);
  data = $state.raw<Meteogram | null>(null);
  /** series switched on (only these frames are downloaded) */
  include = $state<SeriesKey[]>([...SERIES_KEYS]);
  loaded = $state(0);
  total = $state(0);
  error = $state<string | null>(null);
  /** ms the last full rebuild from cache took (instant-feel evidence) */
  lastBuildMs = $state(0);
  private token = 0;
  private raf = 0;

  get busy(): boolean {
    return this.total > 0 && this.loaded < this.total;
  }

  open(lon: number, lat: number): void {
    this.point = { lon, lat };
    void this.run();
  }
  close(): void {
    this.point = null;
    this.data = null;
    this.token++;
  }
  toggleSeries(k: SeriesKey): void {
    this.include = this.include.includes(k) ? this.include.filter((x) => x !== k) : [...this.include, k];
    void this.run();
  }

  private rebuild(): void {
    const lm = app.loadedModel;
    const p = this.point;
    if (!lm || !p) return;
    const t0 = performance.now();
    const lookup = (f: VectorField | ScalarField, index: number) => {
      const ref: FrameRef = { base: lm.base, model: lm.model, field: f, index };
      return weather.store.peekPacked(ref);
    };
    this.data = buildMeteogram(lm.model, p.lon, p.lat, lookup, this.include);
    this.lastBuildMs = Math.round((performance.now() - t0) * 100) / 100;
    this.loaded = this.data.total - this.data.pending;
    this.total = this.data.total;
  }

  /** Re-run for the current point / model (also called when the model changes). */
  async run(): Promise<void> {
    const lm = app.loadedModel;
    if (!lm || !this.point) return;
    const my = ++this.token;
    this.error = null;
    this.rebuild(); // instant for anything cached
    const todo = meteogramFrames(lm.model, this.include)
      .map((r): FrameRef => ({ base: lm.base, model: lm.model, field: r.field, index: r.index }))
      .filter((r) => !weather.store.hasPacked(r));
    if (!todo.length) return;
    // current frame first, then outward in time, so the series fills in around "now"
    const cur = app.frameIdx;
    todo.sort((a, b) => Math.abs(a.index - cur) - Math.abs(b.index - cur));
    const queue = [...todo];
    const schedule = () => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (my === this.token) this.rebuild();
      });
    };
    const worker = async () => {
      for (let r = queue.shift(); r && my === this.token; r = queue.shift()) {
        try {
          await weather.store.ensure(r, false);
        } catch (e) {
          if (my === this.token) this.error = `${frameKey(r)}: ${(e as Error).message}`;
        }
        schedule();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (my === this.token) this.rebuild();
  }
}

/** the card that follows map clicks, and one card the user pinned */
export const meteo = new MeteoState();
export const meteoPinned = new MeteoState();
