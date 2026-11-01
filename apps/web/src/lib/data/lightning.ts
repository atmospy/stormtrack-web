/** CONTRACTS section 6 (lightning): index, compact flash columns, coverage footprint. */
import { ContractError } from './contracts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (c: string, p: string, v: unknown): Obj => {
  if (!isObj(v)) throw new ContractError(c, p, 'expected an object');
  return v;
};
const num = (c: string, p: string, v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError(c, p, `expected a finite number, got ${JSON.stringify(v)}`);
  return v;
};
const isoZ = (c: string, p: string, v: unknown): string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(v) || Number.isNaN(Date.parse(v)))
    throw new ContractError(c, p, `expected UTC ISO-8601 with trailing Z, got ${JSON.stringify(v)}`);
  return v;
};

export interface LightningSource {
  id: string;
  name: string;
  licence: string;
  satellites: string[];
  latency_s: number | null;
  coverage: string | null;
  /** credit line to show when this source has strikes in view */
  attribution: string;
  kind: string;
  /** "bucketed": flash times are only known to a bucket, so never show an exact timestamp (age fade only) */
  time_precision: 'exact' | 'bucketed';
  time_uncertainty_s: number | null;
  unofficial: boolean;
  stale: boolean;
  updated: string | null;
}
export interface LightningIndex {
  schema: 1;
  generated: string;
  updated: string;
  window_minutes: number;
  count: number;
  stale: boolean;
  /** share of detected flashes kept when the row cap forced a uniform sample (1 = all); from `state.keep_fraction` */
  keepFraction: number;
  /** CONTRACTS 6.2: playback delay and publishing interval for the live feed (null on older files) */
  live: { delay_s: number; poll_s: number } | null;
  sources: LightningSource[];
  notes: string;
}

export function parseLightningIndex(raw: unknown): LightningIndex {
  const C = 'lightning/index.json';
  const o = obj(C, '$', raw);
  const schema = num(C, 'schema', o.schema);
  if (schema !== 1) throw new ContractError(C, 'schema', `unsupported schema ${schema} (this app understands 1)`);
  if (o.sources !== undefined && !Array.isArray(o.sources)) throw new ContractError(C, 'sources', 'expected an array');
  const sources = ((o.sources as unknown[] | undefined) ?? []).map((s, i): LightningSource => {
    const so = obj(C, `sources[${i}]`, s);
    return {
      id: typeof so.id === 'string' ? so.id : `source${i}`,
      name: typeof so.name === 'string' ? so.name : 'lightning feed',
      licence: typeof so.licence === 'string' ? so.licence : '',
      satellites: Array.isArray(so.satellites) ? so.satellites.filter((x): x is string => typeof x === 'string') : [],
      latency_s: typeof so.latency_s === 'number' ? so.latency_s : null,
      coverage: typeof so.coverage === 'string' ? so.coverage : null,
      attribution: typeof so.attribution === 'string' && so.attribution ? so.attribution : typeof so.licence === 'string' ? so.licence : '',
      kind: typeof so.kind === 'string' ? so.kind : '',
      time_precision: so.time_precision === 'bucketed' ? 'bucketed' : 'exact',
      time_uncertainty_s: typeof so.time_uncertainty_s === 'number' ? so.time_uncertainty_s : null,
      unofficial: so.unofficial === true,
      stale: so.stale === true,
      updated: typeof so.updated === 'string' && !Number.isNaN(Date.parse(so.updated)) ? so.updated : null
    };
  });
  return {
    schema: 1,
    generated: isoZ(C, 'generated', o.generated),
    updated: isoZ(C, 'updated', o.updated),
    window_minutes: num(C, 'window_minutes', o.window_minutes),
    count: num(C, 'count', o.count),
    stale: o.stale === true,
    live: isObj(o.live) && typeof o.live.delay_s === 'number' && typeof o.live.poll_s === 'number' ? { delay_s: o.live.delay_s, poll_s: o.live.poll_s } : null,
    keepFraction: (() => {
      const k = isObj(o.state) ? (o.state as Obj).keep_fraction : undefined;
      return typeof k === 'number' && k > 0 && k <= 1 ? k : 1;
    })(),
    sources,
    notes: typeof o.notes === 'string' ? o.notes : ''
  };
}

/** Flashes as typed columns (100k rows = ~1.6 MB), sorted by time. */
export interface Flashes {
  t0: number; // epoch ms
  n: number;
  dt: Float32Array; // seconds since t0
  lon: Float32Array;
  lat: Float32Array;
  energy: Float32Array; // fJ, 0 when absent or null (draw at the default size)
  /** index into index.sources (0 for the older 4-column form) */
  src: Uint8Array;
}

export function parseFlashes(raw: unknown): Flashes {
  const C = 'lightning/flashes.json';
  const o = obj(C, '$', raw);
  const schema = num(C, 'schema', o.schema);
  if (schema !== 1) throw new ContractError(C, 'schema', `unsupported schema ${schema} (this app understands 1)`);
  const t0 = Date.parse(isoZ(C, 't0', o.t0));
  if (!Array.isArray(o.cols)) throw new ContractError(C, 'cols', 'expected an array of column names');
  const cols = o.cols as unknown[];
  const ix = (name: string, required: boolean) => {
    const i = cols.indexOf(name);
    if (i < 0 && required) throw new ContractError(C, 'cols', `missing required column "${name}" (have ${JSON.stringify(cols)})`);
    return i;
  };
  const cd = ix('dt_s', true), cx = ix('lon', true), cy = ix('lat', true), ce = ix('energy_fj', false), cs = ix('src', false);
  if (!Array.isArray(o.rows)) throw new ContractError(C, 'rows', 'expected an array of rows');
  const rows = o.rows as unknown[];
  const n = rows.length;
  const dt = new Float32Array(n), lon = new Float32Array(n), lat = new Float32Array(n), energy = new Float32Array(n), src = new Uint8Array(n);
  let prev = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) throw new ContractError(C, `rows[${i}]`, 'expected an array');
    const d = r[cd], x = r[cx], y = r[cy];
    if (typeof d !== 'number' || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(d + x + y))
      throw new ContractError(C, `rows[${i}]`, `dt_s/lon/lat must be finite numbers, got ${JSON.stringify(r)}`);
    if (x < -180 || x > 180 || y < -90 || y > 90) throw new ContractError(C, `rows[${i}]`, `position ${x}, ${y} outside lon -180..180 / lat -90..90`);
    if (d < prev) throw new ContractError(C, `rows[${i}].dt_s`, `rows must be sorted by time (${d} after ${prev})`);
    prev = d;
    dt[i] = d; lon[i] = x; lat[i] = y;
    energy[i] = ce >= 0 && typeof r[ce] === 'number' ? (r[ce] as number) : 0;
    if (cs >= 0 && r[cs] !== null && r[cs] !== undefined) {
      const sv = r[cs];
      if (typeof sv !== 'number' || !Number.isInteger(sv) || sv < 0 || sv > 255) throw new ContractError(C, `rows[${i}].src`, `expected a small non-negative integer index into index.sources, got ${JSON.stringify(sv)}`);
      src[i] = sv;
    }
  }
  return { t0, n, dt, lon, lat, energy, src };
}

/** Coverage footprint: accepts a FeatureCollection, a Feature or a bare geometry; only (Multi)Polygon parts are kept. */
export function parseCoverage(raw: unknown): GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
  const C = 'lightning/coverage.geojson';
  const o = obj(C, '$', raw);
  const geoms: (GeoJSON.Polygon | GeoJSON.MultiPolygon)[] = [];
  const take = (g: unknown, p: string) => {
    const go = obj(C, p, g);
    if (go.type === 'Polygon' || go.type === 'MultiPolygon') {
      if (!Array.isArray(go.coordinates)) throw new ContractError(C, `${p}.coordinates`, 'expected an array');
      geoms.push(go as unknown as GeoJSON.Polygon);
    } else throw new ContractError(C, `${p}.type`, `expected Polygon or MultiPolygon, got ${JSON.stringify(go.type)}`);
  };
  if (o.type === 'FeatureCollection') {
    if (!Array.isArray(o.features)) throw new ContractError(C, 'features', 'expected an array');
    (o.features as unknown[]).forEach((f, i) => take(obj(C, `features[${i}]`, f).geometry, `features[${i}].geometry`));
  } else if (o.type === 'Feature') take(o.geometry, 'geometry');
  else take(o, '$');
  if (geoms.length === 0) throw new ContractError(C, 'features', 'no polygon geometry found');
  return { type: 'FeatureCollection', features: geoms.map((g) => ({ type: 'Feature', geometry: g, properties: {} })) };
}

// ---------- pure helpers ----------
/** Index of the first flash with age <= windowMs at `nowMs` (flashes are time-sorted). */
export function firstInWindow(f: Flashes, nowMs: number, windowMs: number): number {
  const cut = (nowMs - windowMs - f.t0) / 1000;
  let lo = 0, hi = f.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f.dt[mid]! < cut) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function countInWindow(f: Flashes, nowMs: number, windowMs: number): number {
  const first = firstInWindow(f, nowMs, windowMs);
  const cutNow = (nowMs - f.t0) / 1000;
  let end = f.n;
  while (end > first && f.dt[end - 1]! > cutNow) end--;
  return end - first;
}

/** Ray-casting point-in-polygon over a (Multi)Polygon coverage; longitude is compared as given. */
export function inCoverage(cov: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>, lon: number, lat: number): boolean {
  const inRing = (ring: number[][]) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!, [xj, yj] = ring[j]!;
      if (yi! > lat !== yj! > lat && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
    }
    return inside;
  };
  const inPoly = (rings: number[][][]) => inRing(rings[0]!) && !rings.slice(1).some(inRing);
  for (const f of cov.features) {
    const g = f.geometry;
    if (g.type === 'Polygon' ? inPoly(g.coordinates) : g.coordinates.some(inPoly)) return true;
  }
  return false;
}

/** Per-source counts of flashes in the time window and inside a lon/lat box (lon may wrap: west > east). */
export function countBySource(f: Flashes, nowMs: number, windowMs: number, box: { west: number; south: number; east: number; north: number } | null, nSources: number): number[] {
  const out = new Array<number>(Math.max(1, nSources)).fill(0);
  const first = firstInWindow(f, nowMs, windowMs);
  const cutNow = (nowMs - f.t0) / 1000;
  for (let i = first; i < f.n && f.dt[i]! <= cutNow; i++) {
    if (box) {
      const x = f.lon[i]!, y = f.lat[i]!;
      if (y < box.south || y > box.north) continue;
      if (box.west <= box.east ? x < box.west || x > box.east : x < box.west && x > box.east) continue;
    }
    const s = f.src[i]!;
    if (s < out.length) out[s]!++;
  }
  return out;
}

// ---------- CONTRACTS 6.2: recent.json (live feed for animation + sound) ----------
export interface Strike {
  id: string;
  /** unix ms of the strike */
  t_ms: number;
  lon: number;
  lat: number;
  /** fJ; null when the source does not report it (draw at a default size) */
  energy_fj: number | null;
  src: number;
}
export interface Recent {
  generated: string;
  window_s: number;
  strikes: Strike[];
}
export function parseRecent(raw: unknown): Recent {
  const C = 'lightning/recent.json';
  const o = obj(C, '$', raw);
  const schema = num(C, 'schema', o.schema);
  if (schema !== 1) throw new ContractError(C, 'schema', `unsupported schema ${schema} (this app understands 1)`);
  if (!Array.isArray(o.cols) || !Array.isArray(o.rows)) throw new ContractError(C, 'cols', 'expected "cols" and "rows" arrays');
  const cols = o.cols as unknown[];
  const ix = (n: string, req = true) => {
    const i = cols.indexOf(n);
    if (i < 0 && req) throw new ContractError(C, 'cols', `missing required column "${n}" (have ${JSON.stringify(cols)})`);
    return i;
  };
  const ci = ix('id'), ct = ix('t_ms'), cx = ix('lon'), cy = ix('lat'), ce = ix('energy_fj', false), cs = ix('src', false);
  const strikes = (o.rows as unknown[]).map((r, i): Strike => {
    if (!Array.isArray(r)) throw new ContractError(C, `rows[${i}]`, 'expected an array');
    const id = r[ci], t = r[ct], x = r[cx], y = r[cy];
    if (typeof id !== 'string' || id === '') throw new ContractError(C, `rows[${i}].id`, `expected a non-empty string, got ${JSON.stringify(id)}`);
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 1e11) throw new ContractError(C, `rows[${i}].t_ms`, `expected unix milliseconds, got ${JSON.stringify(t)}`);
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x + y) || Math.abs(x) > 180 || Math.abs(y) > 90)
      throw new ContractError(C, `rows[${i}]`, `lon/lat out of range: ${JSON.stringify([x, y])}`);
    const e = ce >= 0 ? r[ce] : null;
    const s = cs >= 0 && typeof r[cs] === 'number' ? (r[cs] as number) : 0;
    return { id, t_ms: t, lon: x, lat: y, energy_fj: typeof e === 'number' && Number.isFinite(e) ? e : null, src: s };
  });
  return { generated: isoZ(C, 'generated', o.generated), window_s: typeof o.window_s === 'number' ? o.window_s : 90, strikes };
}
