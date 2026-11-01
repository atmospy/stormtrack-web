import { DATA_BASE } from '#lib/config';
import { loadModel } from '#lib/data/load';
import type { WeatherField, WeatherModel } from '#lib/data/weather';
import { app } from '#lib/stores/app.svelte';
import type { Packed } from './pack';
import { nearestIndex, scalarField, timeline, windFieldAt, windFields, levelKey } from './select';
import { sampleScalar, sampleVector, type WindSample } from './sample';
import { FrameStore, frameUrl, type FrameRef } from './store';

/** Frames to decode ahead of the playhead, per active field. */
export const PREFETCH_AHEAD = 3;

export interface Shown {
  ref: FrameRef;
  bitmap: ImageBitmap;
  packed: Packed;
  field: WeatherField;
  model: WeatherModel;
}
/** The displayed frame and (when cached) the following frame for temporal blending. */
export interface Slot {
  cur: Shown;
  next: Shown | null;
}
interface Want {
  ref: FrameRef;
  nextRef: FrameRef | null;
}

const refFor = (base: string, model: WeatherModel, field: WeatherField, index: number): FrameRef => ({ base, model, field, index });

/**
 * The one place that turns "model / variable / level / valid time" into decoded frames for the map.
 * - Wind slot: particles (variable = wind, or an overlay over a scalar).
 * - Scalar slot: colour fill (pressure, temperature, precipitation).
 * Both slots commit together, so switching model/level/variable never shows an empty map: the old frames stay
 * until the new ones are decoded.
 */
class WeatherRuntime {
  readonly store = new FrameStore();
  wind = $state.raw<Slot | null>(null);
  scalar = $state.raw<Slot | null>(null);
  mix = $state(0);
  error = $state<string | null>(null);
  loading = $state(false);
  /** ms from navigation start to the first displayed weather frame */
  firstFrameMs = $state<number | null>(null);
  private token = 0;
  private modelLoads = new Map<string, Promise<void>>();

  private want(ms: number, nextMs: number | null): { wind: Want | null; scalar: Want | null } | null {
    const lm = app.loadedModel;
    if (!lm) return null;
    const m = lm.model;
    const pick = (f: WeatherField | null): Want | null => {
      if (!f) return null;
      const t = timeline(f);
      const i = nearestIndex(t, ms);
      const j = nextMs === null ? i : nearestIndex(t, nextMs);
      return { ref: refFor(lm.base, m, f, i), nextRef: j !== i ? refFor(lm.base, m, f, j) : null };
    };
    const windF = app.variable === 'wind' || app.overlay ? windFieldAt(m, app.level) : null;
    const scF = app.variable !== 'wind' ? scalarField(m, app.variable) : null;
    return { wind: pick(windF), scalar: pick(scF) };
  }

  private shown(ref: FrameRef): Shown | null {
    const bitmap = this.store.peekBitmap(ref);
    const packed = this.store.peekPacked(ref);
    return bitmap && packed ? { ref, bitmap, packed, field: ref.field, model: ref.model } : null;
  }

  /** Are the frames for `ms` already decoded (so playback can step without waiting)? */
  isReady(ms: number): boolean {
    const w = this.want(ms, null);
    if (!w) return false;
    return [w.wind, w.scalar].every((x) => !x || this.store.hasBitmap(x.ref));
  }

  /** Decode the frames needed at `ms` (playback calls this when it is about to run out of cached frames). */
  async ensureAt(ms: number): Promise<void> {
    const w = this.want(ms, null);
    if (!w) return;
    await Promise.all([w.wind, w.scalar].map((x) => (x ? this.store.ensure(x.ref, true) : undefined)));
  }

  /** Reconcile the displayed frames with app state. Reads of app.* before the first await are tracked by callers' effects. */
  async show(): Promise<void> {
    if (!app.layers.wind || app.validMs === null) return;
    const t = app.times;
    const idx = app.frameIdx;
    const want = this.want(app.validMs, t[idx + 1] ?? null);
    if (!want) return;
    const my = ++this.token;
    this.loading = true;
    try {
      const load = async (w: Want | null): Promise<Slot | null> => {
        if (!w) return null;
        await this.store.ensure(w.ref, true);
        const cur = this.shown(w.ref);
        if (!cur) throw new Error(`frame ${w.ref.field.slug}#${w.ref.index} was evicted while loading`);
        return { cur, next: w.nextRef ? this.shown(w.nextRef) : null };
      };
      const [wind, scalar] = await Promise.all([load(want.wind), load(want.scalar)]);
      if (my !== this.token) return; // a newer request superseded this one
      this.error = null;
      this.wind = wind;
      this.scalar = scalar;
      this.mix = 0;
      if (this.firstFrameMs === null) {
        this.firstFrameMs = Math.round(performance.now());
        (window as unknown as { __st?: Record<string, unknown> }).__st = { ...(window as unknown as { __st?: object }).__st, firstFrameMs: this.firstFrameMs };
      }
      this.prefetch(my, want, idx);
    } catch (e) {
      if (my === this.token) this.error = (e as Error).message;
    } finally {
      if (my === this.token) this.loading = false;
    }
  }

  /** Decode the next frames (blend target first, then a few ahead) and refresh `next` as they land. */
  private prefetch(my: number, want: { wind: Want | null; scalar: Want | null }, idx: number): void {
    const t = app.times;
    const slots: ['wind' | 'scalar', Want | null][] = [['wind', want.wind], ['scalar', want.scalar]];
    for (const [name, w] of slots) {
      if (!w) continue;
      const times = timeline(w.ref.field);
      const refs: FrameRef[] = [];
      if (w.nextRef) refs.push(w.nextRef);
      for (let k = 1; k <= PREFETCH_AHEAD; k++) {
        const ms = t[idx + k];
        if (ms === undefined) break;
        const j = nearestIndex(times, ms);
        if (!refs.some((r) => r.index === j) && j !== w.ref.index) refs.push(refFor(w.ref.base, w.ref.model, w.ref.field, j));
      }
      refs.forEach((r, n) => {
        if (this.store.hasBitmap(r)) return;
        this.store.ensure(r, true).then(() => {
          if (n !== 0 || my !== this.token) return;
          const slot = this[name];
          const nx = this.shown(r);
          if (slot && nx && slot.cur.ref.index === w.ref.index && slot.cur.ref.field === w.ref.field) this[name] = { cur: slot.cur, next: nx };
        }).catch(() => {});
      });
    }
    this.idlePrefetch();
  }

  private idleHandle = 0;
  /** Warm the HTTP/service-worker cache for neighbouring levels and other models at the current time. */
  private idlePrefetch(): void {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (nav.connection?.saveData) return;
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 600));
    (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(this.idleHandle);
    this.idleHandle = ric(() => void this.warmNeighbours(), { timeout: 4000 });
  }

  private async warmNeighbours(): Promise<void> {
    const lm = app.loadedModel;
    if (!lm || app.validMs === null) return;
    const urls: string[] = [];
    const ms = app.validMs;
    const add = (base: string, m: WeatherModel, f: WeatherField | null) => {
      if (!f) return;
      const i = nearestIndex(timeline(f), ms);
      const r = refFor(base, m, f, i);
      if (!this.store.hasPacked(r)) urls.push(frameUrl(r));
    };
    // adjacent levels
    const levels = windFields(lm.model).map(levelKey);
    const at = levels.indexOf(app.level);
    for (const l of [levels[at - 1], levels[at + 1]]) if (l) add(lm.base, lm.model, windFieldAt(lm.model, l));
    // the other models, same variable (loading their pointers on the way)
    for (const e of app.catalogue) {
      if (e.id === app.modelId) continue;
      await this.ensureModel(e.id);
      const other = app.models[e.id];
      if (other) add(other.base, other.model, app.variable === 'wind' ? windFieldAt(other.model, app.level) : scalarField(other.model, app.variable));
    }
    for (const u of urls.slice(0, 6)) {
      try {
        const res = await fetch(u, { priority: 'low' } as RequestInit);
        await res.arrayBuffer();
      } catch { /* prefetch is best effort */ }
    }
  }

  /** Load a catalogue model's pointer file on demand (once). */
  ensureModel(id: string): Promise<void> {
    if (app.models[id]) return Promise.resolve();
    let p = this.modelLoads.get(id);
    if (!p) {
      const entry = app.catalogue.find((e) => e.id === id);
      const base = app.loadedModel?.base ?? DATA_BASE;
      p = entry
        ? loadModel(entry, base).then((r) => {
            if (r.ok) app.models = { ...app.models, [id]: { model: r.model, base } };
            else this.modelLoads.delete(id);
          })
        : Promise.resolve();
      this.modelLoads.set(id, p);
    }
    return p;
  }

  sampleWind(lon: number, lat: number): WindSample | null {
    const s = this.wind?.cur;
    if (!s || s.field.kind !== 'vector') return null;
    return sampleVector(s.packed, s.model.grid, s.field.range, lon, lat);
  }
  sampleScalarAt(lon: number, lat: number): number | null {
    const s = this.scalar?.cur;
    if (!s || s.field.kind !== 'scalar') return null;
    return sampleScalar(s.packed, s.model.grid, s.field.range, s.field.transform, lon, lat);
  }
}

export const weather = new WeatherRuntime();
