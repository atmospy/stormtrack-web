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
  type WindLatest
} from './contracts';

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

export const loadWind = (signal?: AbortSignal) => resolve<WindLatest>('wind/latest.json', parseWindLatest, signal);
export const loadActive = (signal?: AbortSignal) => resolve<ActiveStorms>('storms/active.geojson', parseActiveStorms, signal);

export async function loadStormsIndex(base: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const raw = await getJson(`${base}/storms/index.json`, signal);
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
}
export const loadHistory = (basin: string, base: string, signal?: AbortSignal) =>
  resolve<HistoryCollection>(`storms/history/${basin}.geojson`, parseHistory, signal, [base]);
export const loadStats = (basin: string, base: string, signal?: AbortSignal) =>
  resolve<BasinStats>(`storms/stats/${basin}.json`, parseStats, signal, [base]);

export const loadHazardIndex = (signal?: AbortSignal) => resolve<HazardIndex>('hazards/index.json', parseHazardIndex, signal);
export const loadHazardLayer = (name: 'events' | 'quakes' | 'fires', base: string, signal?: AbortSignal) =>
  resolve<GeoJSON.FeatureCollection<GeoJSON.Point>>(`hazards/${name}.geojson`, parseHazardPoints, signal, [base]);

export const windFrameUrl = (base: string, png: string) => `${base}/${png}`;
