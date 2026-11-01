import { historyVertices, type HistoryCollection } from '#lib/data/contracts';
import type { BasinEntry, HistoryIndex } from '#lib/data/history';
import { loadHistory } from '#lib/data/load';
import { SAMPLE_BASE } from '#lib/config';
import { categoryFromLabel } from '#lib/util/storm';
import { distBearing } from '#lib/util/storm';

type Feat = HistoryCollection['features'][number];

/** Rank 0..6 (TD..C5) of a storm's peak, using the contract label with a wind fallback. */
export function peakRank(p: { category: string | null; max_wind_kt: number | null }): number {
  return categoryFromLabel(p.category, p.max_wind_kt).rank;
}

/** Storms whose track passes within `radiusKm` of a point (vertex distance; tracks are densely sampled). */
export function stormsNear(feats: Iterable<Feat>, lon: number, lat: number, radiusKm: number): Feat[] {
  const out: Feat[] = [];
  const dLat = radiusKm / 111 + 1;
  const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  for (const f of feats) {
    const cs = historyVertices(f.geometry);
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i]!;
      if (Math.abs(c[1]! - lat) > dLat) continue;
      let dl = Math.abs(c[0]! - lon);
      if (dl > 180) dl = 360 - dl;
      if (dl > dLon) continue;
      if (distBearing(lon, lat, c[0]!, c[1]!).km <= radiusKm) {
        out.push(f);
        break;
      }
    }
  }
  return out;
}

class HistoryState {
  index = $state.raw<HistoryIndex | null>(null);
  base = '';
  /** basins ticked in the panel (data is fetched on first tick) */
  enabled = $state<string[]>([]);
  loaded = $state.raw<Record<string, HistoryCollection>>({});
  loading = $state<Record<string, boolean>>({});
  failed = $state<Record<string, string>>({});
  /** null = full range of the enabled basins */
  years = $state<[number, number] | null>(null);
  minCategory = $state(0);
  /** highlight storms that passed within `nearKm` of the last clicked point */
  near = $state(false);
  nearKm = $state(300);
  point = $state<{ lon: number; lat: number } | null>(null);
  private inflight = new Map<string, Promise<void>>();

  get entries(): BasinEntry[] {
    return this.index?.basins ?? [];
  }
  get range(): [number, number] {
    const es = this.entries.filter((e) => this.enabled.includes(e.code));
    const all = es.length ? es : this.entries;
    if (!all.length) return [1850, new Date().getUTCFullYear()];
    return [Math.min(...all.map((e) => e.year_min)), Math.max(...all.map((e) => e.year_max))];
  }
  get yearsEffective(): [number, number] {
    const r = this.range;
    const y = this.years;
    return y ? [Math.max(r[0], y[0]), Math.min(r[1], y[1])] : r;
  }
  /** every feature of every loaded basin (map filters decide what is visible) */
  get all(): Feat[] {
    return Object.values(this.loaded).flatMap((c) => c.features);
  }
  /** features matching the current filters (CPU copy for counts, search and "near") */
  get visible(): Feat[] {
    const [y0, y1] = this.yearsEffective;
    return this.enabled.flatMap((b) => this.loaded[b]?.features ?? []).filter((f) => f.properties.year >= y0 && f.properties.year <= y1 && peakRank(f.properties) >= this.minCategory);
  }
  find(id: string): Feat | null {
    for (const c of Object.values(this.loaded)) {
      const f = c.features.find((x) => x.properties.id === id);
      if (f) return f;
    }
    return null;
  }

  setIndex(index: HistoryIndex, base: string): void {
    this.index = index;
    this.base = base;
  }

  /** Fetch a basin file on first use (real data root first, then the sample). */
  ensure(code: string): Promise<void> {
    if (this.loaded[code]) return Promise.resolve();
    let p = this.inflight.get(code);
    if (!p) {
      this.loading[code] = true;
      const entry = this.entries.find((e) => e.code === code);
      p = (async () => {
        let r = await loadHistory(code, this.base, undefined, entry?.file);
        if (!r.ok && r.missing && this.base !== SAMPLE_BASE) r = await loadHistory(code, SAMPLE_BASE, undefined, entry?.file);
        if (r.ok) this.loaded = { ...this.loaded, [code]: r.value.data };
        else this.failed[code] = r.error;
      })().finally(() => {
        this.loading[code] = false;
        this.inflight.delete(code);
      });
      this.inflight.set(code, p);
    }
    return p;
  }

  toggleBasin(code: string, on?: boolean): void {
    const want = on ?? !this.enabled.includes(code);
    this.enabled = want ? [...new Set([...this.enabled, code])] : this.enabled.filter((b) => b !== code);
    if (want) void this.ensure(code);
  }
  setEnabled(codes: string[]): void {
    const valid = codes.filter((c) => this.entries.some((e) => e.code === c));
    this.enabled = valid;
    for (const c of valid) void this.ensure(c);
  }
}

export const history = new HistoryState();
