import { DATA_BASE, SAMPLE_BASE } from '#lib/config';
import {
  ContractError,
  parseActiveStorms,
  parseHazardIndex,
  parseHazardPoints,
  parseHistory,
  parseStats,
  parseWindLatest,
  type ActiveStorms,
  type BasinStats,
  type HazardIndex,
  type HistoryCollection,
  type NowcastFile,
  type SatelliteMeta,
  parseNowcast,
  parseSatellite
} from './contracts';
import { parseHistoryIndex, type HistoryIndex } from './history';
import { parseCoverage, parseFlashes, parseLightningIndex, type Flashes, type LightningIndex } from './lightning';
import { modelFromLegacyWind, parseWeatherIndex, parseWeatherModel, type WeatherIndexEntry, type WeatherModel } from './weather';

export interface Loaded<T> {
  data: T;
  /** data root the file came from (needed to resolve relative frame paths) */
  base: string;
  /** true when the real file was missing and the bundled sample was used */
  sample: boolean;
}
export type Result<T> = { ok: true; value: Loaded<T> } | { ok: false; error: string; missing: boolean };

/** Fetch JSON; null when missing / not JSON (so SPA-fallback HTML never counts as data). */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return null;
    return await res.json();
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return null;
  }
}

/** Try the configured data root, then the bundled sample. */
async function resolve<T>(path: string, parse: (raw: unknown) => T, signal?: AbortSignal, bases?: string[]): Promise<Result<T>> {
  const candidates = bases ?? (DATA_BASE === SAMPLE_BASE ? [DATA_BASE] : [DATA_BASE, SAMPLE_BASE]);
  for (const base of candidates) {
    const raw = await getJson(`${base}/${path}`, signal);
    if (raw === null) continue;
    try {
      return { ok: true, value: { data: parse(raw), base, sample: base === SAMPLE_BASE && DATA_BASE !== SAMPLE_BASE } };
    } catch (e) {
      // A real file that violates the contract is an error, not a reason to silently show sample data.
      const msg = e instanceof ContractError ? e.message : `Could not parse ${path}: ${(e as Error).message}`;
      console.warn(msg);
      return { ok: false, error: msg, missing: false };
    }
  }
  return { ok: false, error: `${path} not found`, missing: true };
}

export interface Catalogue {
  entries: WeatherIndexEntry[];
  /** first usable model, already loaded */
  first: WeatherModel;
  base: string;
  sample: boolean;
  /** true when only the legacy CONTRACTS section 1 wind file was available */
  legacy: boolean;
}

/**
 * Weather catalogue with graceful degradation: real weather/index.json (+ first model) -> real legacy wind/latest.json
 * -> sample weather/index.json -> sample legacy wind. A real file that violates the contract is reported and skipped
 * (the next source is tried), never silently half-used.
 */
export async function loadCatalogue(signal?: AbortSignal): Promise<{ ok: true; value: Catalogue } | { ok: false; error: string; missing: boolean }> {
  const bases = DATA_BASE === SAMPLE_BASE ? [DATA_BASE] : [DATA_BASE, SAMPLE_BASE];
  const errors: string[] = [];
  for (const base of bases) {
    const isSample = base === SAMPLE_BASE && DATA_BASE !== SAMPLE_BASE;
    const rawIdx = await getJson(`${base}/weather/index.json`, signal);
    if (rawIdx !== null) {
      try {
        const index = parseWeatherIndex(rawIdx);
        const entries = [...index.models].sort((a, b) => (a.id === 'gfs' ? -1 : b.id === 'gfs' ? 1 : 0));
        for (const e of entries) {
          const m = await loadModel(e, base, signal);
          if (m.ok) return { ok: true, value: { entries: index.models, first: m.model, base, sample: isSample, legacy: false } };
          errors.push(m.error);
        }
      } catch (e) {
        const msg = e instanceof ContractError ? e.message : `Could not parse weather/index.json: ${(e as Error).message}`;
        console.warn(msg);
        errors.push(msg);
      }
    }
    const rawWind = await getJson(`${base}/wind/latest.json`, signal);
    if (rawWind !== null) {
      try {
        const m = modelFromLegacyWind(parseWindLatest(rawWind));
        const entry: WeatherIndexEntry = { id: m.model, name: m.name, licence: m.licence, run: m.run, latest: 'wind/latest.json' };
        return { ok: true, value: { entries: [entry], first: m, base, sample: isSample, legacy: true } };
      } catch (e) {
        const msg = e instanceof ContractError ? e.message : `Could not parse wind/latest.json: ${(e as Error).message}`;
        console.warn(msg);
        errors.push(msg);
      }
    }
  }
  return errors.length ? { ok: false, error: errors.join('; '), missing: false } : { ok: false, error: 'weather data not found', missing: true };
}

export async function loadModel(entry: WeatherIndexEntry, base: string, signal?: AbortSignal): Promise<{ ok: true; model: WeatherModel } | { ok: false; error: string }> {
  const raw = await getJson(`${base}/${entry.latest}`, signal);
  if (raw === null) return { ok: false, error: `${entry.latest} not found` };
  try {
    const m = parseWeatherModel(raw, entry.id);
    // the pointer file need not repeat the display name / licence that the catalogue already carries
    const o = raw as Record<string, unknown>;
    return { ok: true, model: { ...m, name: typeof o.name === 'string' && o.name ? m.name : entry.name, licence: typeof o.licence === 'string' && o.licence ? m.licence : entry.licence } };
  } catch (e) {
    const msg = e instanceof ContractError ? e.message : `Could not parse ${entry.latest}: ${(e as Error).message}`;
    console.warn(msg);
    return { ok: false, error: msg };
  }
}

export const loadHistoryIndex = async (base: string, signal?: AbortSignal): Promise<{ ok: true; index: HistoryIndex } | { ok: false; error: string; missing: boolean }> => {
  for (const path of ['storms/history/all-index.json', 'storms/index.json']) {
    const raw = await getJson(`${base}/${path}`, signal);
    if (raw === null) continue;
    try {
      return { ok: true, index: parseHistoryIndex(raw) };
    } catch (e) {
      if (path.endsWith('all-index.json')) {
        console.warn((e as Error).message);
        return { ok: false, error: (e as Error).message, missing: false };
      }
    }
  }
  return { ok: false, error: 'history index not found', missing: true };
};

export interface LightningBundle {
  index: LightningIndex;
  flashes: Flashes | null;
  coverage: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null;
  base: string;
  sample: boolean;
  /** problems that did not stop the layer (missing coverage, etc.) */
  warnings: string[];
  /** true for the simulated demo feed (never real data) */
  demo?: boolean;
}

/** Just index.json from a base (cheap; used by the live refresh between full reloads). Null on any failure. */
export async function loadLightningIndexOnly(base: string, signal?: AbortSignal): Promise<LightningIndex | null> {
  const raw = await getJson(`${base}/lightning/index.json`, signal);
  if (raw === null) return null;
  try {
    return parseLightningIndex(raw);
  } catch {
    return null;
  }
}
/** Index first (it is the pointer), then flashes + coverage; each failure degrades only its own part. */
export async function loadLightning(signal?: AbortSignal): Promise<{ ok: true; value: LightningBundle } | { ok: false; error: string; missing: boolean }> {
  const bases = DATA_BASE === SAMPLE_BASE ? [DATA_BASE] : [DATA_BASE, SAMPLE_BASE];
  for (const base of bases) {
    const rawIdx = await getJson(`${base}/lightning/index.json`, signal);
    if (rawIdx === null) continue;
    let index: LightningIndex;
    try {
      index = parseLightningIndex(rawIdx);
    } catch (e) {
      console.warn((e as Error).message);
      return { ok: false, error: (e as Error).message, missing: false };
    }
    const warnings: string[] = [];
    const covPath = index.sources.find((s) => s.coverage)?.coverage ?? 'lightning/coverage.geojson';
    const [rawF, rawC] = await Promise.all([getJson(`${base}/lightning/flashes.json`, signal), getJson(`${base}/${covPath}`, signal)]);
    let flashes: Flashes | null = null;
    let coverage: LightningBundle['coverage'] = null;
    if (rawF === null) warnings.push('flashes.json not found');
    else {
      try { flashes = parseFlashes(rawF); } catch (e) { warnings.push((e as Error).message); console.warn((e as Error).message); }
    }
    if (rawC === null) warnings.push('coverage.geojson not found');
    else {
      try { coverage = parseCoverage(rawC); } catch (e) { warnings.push((e as Error).message); console.warn((e as Error).message); }
    }
    return { ok: true, value: { index, flashes, coverage, base, sample: base === SAMPLE_BASE && DATA_BASE !== SAMPLE_BASE, warnings } };
  }
  return { ok: false, error: 'lightning feed not published', missing: true };
}
export const loadActive = (signal?: AbortSignal) => resolve<ActiveStorms>('storms/active.geojson', parseActiveStorms, signal);

export async function loadStormsIndex(base: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const raw = await getJson(`${base}/storms/index.json`, signal);
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
}
export const loadHistory = (basin: string, base: string, signal?: AbortSignal, file?: string) =>
  resolve<HistoryCollection>(file ?? `storms/history/${basin}.geojson`, parseHistory, signal, [base]);
export const loadStats = (basin: string, base: string, signal?: AbortSignal, file?: string) =>
  resolve<BasinStats>(file ?? `storms/stats/${basin}.json`, parseStats, signal, [base]);

export const loadHazardIndex = (signal?: AbortSignal) => resolve<HazardIndex>('hazards/index.json', parseHazardIndex, signal);
export const loadHazardLayer = (name: 'events' | 'quakes' | 'fires', base: string, signal?: AbortSignal) =>
  resolve<GeoJSON.FeatureCollection<GeoJSON.Point>>(`hazards/${name}.geojson`, parseHazardPoints, signal, [base]);


/** Nowcast has no bundled sample: a missing file just means the layer is unavailable. */
export const loadNowcast = (signal?: AbortSignal) => resolve<NowcastFile>('nowcast/latest.geojson', parseNowcast, signal, [DATA_BASE]);

/** The INSAT image metadata; no bundled sample either. */
export const loadSatellite = (signal?: AbortSignal) => resolve<SatelliteMeta>('satellite/insat-ir.json', parseSatellite, signal, [DATA_BASE]);
