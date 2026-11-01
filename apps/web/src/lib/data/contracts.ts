/**
 * Runtime validators for the data contracts in docs/CONTRACTS.md.
 * They are strict about what the app relies on and lenient about extra fields,
 * and raise ContractError with a JSON-path-like location so producers can fix bugs fast.
 */

export class ContractError extends Error {
  constructor(
    public readonly contract: string,
    public readonly path: string,
    message: string
  ) {
    super(`[${contract}] ${path}: ${message}`);
    this.name = 'ContractError';
  }
}

// ---------- types ----------
export interface WindImageMeta {
  width: number;
  height: number;
  lon_left: number;
  lon_right: number;
  lat_top: number;
  lat_bottom: number;
  u: { min: number; max: number };
  v: { min: number; max: number };
  speed_max: number;
}
export interface WindFrame {
  fhr: number;
  valid: string;
  png: string;
  bytes?: number;
}
export interface WindLatest {
  schema: number;
  source: string;
  licence: string;
  level: string;
  units: string;
  run: string;
  generated: string;
  image: WindImageMeta;
  frames: WindFrame[];
}

export interface StormCategory {
  scale: string;
  label: string;
}
export interface PositionProps {
  kind: 'position';
  id: string;
  name: string | null;
  basin: string;
  agency: string;
  time: string;
  wind_kt: number | null;
  pressure_hpa: number | null;
  category: StormCategory;
  heading_deg: number | null;
  speed_kmh: number | null;
  wind_period_min: number;
}
export interface TrackProps {
  kind: 'track';
  id: string;
  times: string[];
  wind_kt: (number | null)[];
}
export interface ForecastProps {
  kind: 'forecast';
  id?: string;
  init: string;
  tech: string;
  taus: number[];
  wind_kt: (number | null)[];
  category: string[];
}
export interface ConeProps {
  kind: 'cone';
  id: string;
  radii_km: number[];
  basis: string;
}

export interface Feature<G, P> {
  type: 'Feature';
  geometry: G;
  properties: P;
}
export type Pt = { type: 'Point'; coordinates: [number, number] };
export type Line = { type: 'LineString'; coordinates: [number, number][] };
export type Poly = { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown[] };
export type ActiveFeature =
  | Feature<Pt, PositionProps>
  | Feature<Line, TrackProps>
  | Feature<Line, ForecastProps>
  | Feature<Poly, ConeProps>;
export interface ActiveStorms {
  type: 'FeatureCollection';
  features: ActiveFeature[];
}

// ---------- helpers ----------
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(c: string, p: string, v: unknown): Obj {
  if (!isObj(v)) throw new ContractError(c, p, 'expected an object');
  return v;
}
function num(c: string, p: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError(c, p, `expected a finite number, got ${JSON.stringify(v)}`);
  return v;
}
function str(c: string, p: string, v: unknown): string {
  if (typeof v !== 'string' || v === '') throw new ContractError(c, p, `expected a non-empty string, got ${JSON.stringify(v)}`);
  return v;
}
function isoZ(c: string, p: string, v: unknown): string {
  const s = str(c, p, v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(s) || Number.isNaN(Date.parse(s)))
    throw new ContractError(c, p, `expected UTC ISO-8601 with trailing Z, got "${s}"`);
  return s;
}
function nullableNum(c: string, p: string, v: unknown): number | null {
  return v === null || v === undefined ? null : num(c, p, v);
}
function arr(c: string, p: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ContractError(c, p, 'expected an array');
  return v;
}
function range(c: string, p: string, v: unknown): { min: number; max: number } {
  const o = obj(c, p, v);
  const min = num(c, `${p}.min`, o.min);
  const max = num(c, `${p}.max`, o.max);
  if (!(max > min)) throw new ContractError(c, p, `max (${max}) must be greater than min (${min})`);
  return { min, max };
}

// ---------- wind ----------
export function parseWindLatest(raw: unknown): WindLatest {
  const C = 'wind/latest.json';
  const o = obj(C, '$', raw);
  const schema = num(C, 'schema', o.schema);
  if (schema !== 1) throw new ContractError(C, 'schema', `unsupported schema ${schema} (this app understands 1)`);
  const units = str(C, 'units', o.units);
  if (units !== 'm/s') throw new ContractError(C, 'units', `expected "m/s", got "${units}"`);
  const im = obj(C, 'image', o.image);
  const image: WindImageMeta = {
    width: num(C, 'image.width', im.width),
    height: num(C, 'image.height', im.height),
    lon_left: num(C, 'image.lon_left', im.lon_left),
    lon_right: num(C, 'image.lon_right', im.lon_right),
    lat_top: num(C, 'image.lat_top', im.lat_top),
    lat_bottom: num(C, 'image.lat_bottom', im.lat_bottom),
    u: range(C, 'image.u', im.u),
    v: range(C, 'image.v', im.v),
    speed_max: num(C, 'image.speed_max', im.speed_max)
  };
  if (image.width < 2 || image.height < 2) throw new ContractError(C, 'image', 'width/height must be >= 2');
  if (!(image.lat_top > image.lat_bottom)) throw new ContractError(C, 'image', 'lat_top must be > lat_bottom');
  if (!(image.lon_right > image.lon_left)) throw new ContractError(C, 'image', 'lon_right must be > lon_left');
  if (!(image.speed_max > 0)) throw new ContractError(C, 'image.speed_max', 'must be > 0');

  const frames = arr(C, 'frames', o.frames).map((f, i): WindFrame => {
    const p = `frames[${i}]`;
    const fo = obj(C, p, f);
    const png = str(C, `${p}.png`, fo.png);
    if (/^([a-z]+:)?\/\//i.test(png) || png.startsWith('/'))
      throw new ContractError(C, `${p}.png`, `must be relative to the data root, got "${png}"`);
    return {
      fhr: num(C, `${p}.fhr`, fo.fhr),
      valid: isoZ(C, `${p}.valid`, fo.valid),
      png,
      bytes: fo.bytes === undefined ? undefined : num(C, `${p}.bytes`, fo.bytes)
    };
  });
  if (frames.length === 0) throw new ContractError(C, 'frames', 'must contain at least one frame');
  for (let i = 1; i < frames.length; i++)
    if (frames[i]!.fhr <= frames[i - 1]!.fhr) throw new ContractError(C, `frames[${i}].fhr`, 'frames must be sorted by increasing fhr');

  return {
    schema,
    source: str(C, 'source', o.source),
    licence: typeof o.licence === 'string' ? o.licence : '',
    level: typeof o.level === 'string' ? o.level : '10m',
    units,
    run: isoZ(C, 'run', o.run),
    generated: isoZ(C, 'generated', o.generated),
    image,
    frames
  };
}

// ---------- storms ----------
function lonLat(c: string, p: string, v: unknown): [number, number] {
  const a = arr(c, p, v);
  const lon = num(c, `${p}[0]`, a[0]);
  const lat = num(c, `${p}[1]`, a[1]);
  if (lon < -180 || lon > 180) throw new ContractError(c, `${p}[0]`, `longitude ${lon} outside -180..180`);
  if (lat < -90 || lat > 90) throw new ContractError(c, `${p}[1]`, `latitude ${lat} outside -90..90`);
  return [lon, lat];
}

export function parseActiveStorms(raw: unknown): ActiveStorms {
  const C = 'storms/active.geojson';
  const o = obj(C, '$', raw);
  if (o.type !== 'FeatureCollection') throw new ContractError(C, 'type', 'expected "FeatureCollection"');
  const features = arr(C, 'features', o.features).map((f, i): ActiveFeature => {
    const p = `features[${i}]`;
    const fo = obj(C, p, f);
    const props = obj(C, `${p}.properties`, fo.properties);
    const geom = obj(C, `${p}.geometry`, fo.geometry);
    const kind = props.kind;
    switch (kind) {
      case 'position': {
        if (geom.type !== 'Point') throw new ContractError(C, `${p}.geometry.type`, 'position must be a Point');
        const cat = obj(C, `${p}.properties.category`, props.category);
        const windPeriod = props.wind_period_min === undefined ? undefined : num(C, `${p}.properties.wind_period_min`, props.wind_period_min);
        if (windPeriod !== 1) throw new ContractError(C, `${p}.properties.wind_period_min`, 'position must carry "wind_period_min": 1 (NHC/JTWC are 1-minute winds)');
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: lonLat(C, `${p}.geometry.coordinates`, geom.coordinates) },
          properties: {
            kind: 'position',
            id: str(C, `${p}.properties.id`, props.id),
            name: typeof props.name === 'string' && props.name ? props.name : null,
            basin: str(C, `${p}.properties.basin`, props.basin),
            agency: str(C, `${p}.properties.agency`, props.agency),
            time: isoZ(C, `${p}.properties.time`, props.time),
            wind_kt: nullableNum(C, `${p}.properties.wind_kt`, props.wind_kt),
            pressure_hpa: nullableNum(C, `${p}.properties.pressure_hpa`, props.pressure_hpa),
            category: { scale: str(C, `${p}.properties.category.scale`, cat.scale), label: str(C, `${p}.properties.category.label`, cat.label) },
            heading_deg: nullableNum(C, `${p}.properties.heading_deg`, props.heading_deg),
            speed_kmh: nullableNum(C, `${p}.properties.speed_kmh`, props.speed_kmh),
            wind_period_min: windPeriod
          }
        };
      }
      case 'track':
      case 'forecast': {
        if (geom.type !== 'LineString') throw new ContractError(C, `${p}.geometry.type`, `${kind} must be a LineString`);
        const coords = arr(C, `${p}.geometry.coordinates`, geom.coordinates).map((c, j) => lonLat(C, `${p}.geometry.coordinates[${j}]`, c));
        if (kind === 'track') {
          const times = arr(C, `${p}.properties.times`, props.times).map((t, j) => isoZ(C, `${p}.properties.times[${j}]`, t));
          const wind = arr(C, `${p}.properties.wind_kt`, props.wind_kt).map((w, j) => nullableNum(C, `${p}.properties.wind_kt[${j}]`, w));
          if (times.length !== coords.length || wind.length !== coords.length)
            throw new ContractError(C, p, `track has ${coords.length} vertices but ${times.length} times and ${wind.length} wind_kt values`);
          return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'track', id: str(C, `${p}.properties.id`, props.id), times, wind_kt: wind } };
        }
        const taus = arr(C, `${p}.properties.taus`, props.taus).map((t, j) => num(C, `${p}.properties.taus[${j}]`, t));
        const wind = arr(C, `${p}.properties.wind_kt`, props.wind_kt).map((w, j) => nullableNum(C, `${p}.properties.wind_kt[${j}]`, w));
        const category = arr(C, `${p}.properties.category`, props.category).map((s, j) => str(C, `${p}.properties.category[${j}]`, s));
        if (taus.length !== coords.length || wind.length !== coords.length || category.length !== coords.length)
          throw new ContractError(C, p, `forecast has ${coords.length} vertices but ${taus.length} taus, ${wind.length} wind_kt, ${category.length} category values`);
        return {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { kind: 'forecast', id: typeof props.id === 'string' ? props.id : undefined, init: isoZ(C, `${p}.properties.init`, props.init), tech: typeof props.tech === 'string' ? props.tech : '', taus, wind_kt: wind, category }
        };
      }
      case 'cone': {
        if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') throw new ContractError(C, `${p}.geometry.type`, 'cone must be a Polygon or MultiPolygon');
        arr(C, `${p}.geometry.coordinates`, geom.coordinates);
        return {
          type: 'Feature',
          geometry: { type: geom.type, coordinates: geom.coordinates as unknown[] },
          properties: {
            kind: 'cone',
            id: str(C, `${p}.properties.id`, props.id),
            radii_km: Array.isArray(props.radii_km) ? (props.radii_km as number[]) : [],
            basis: typeof props.basis === 'string' ? props.basis : ''
          }
        };
      }
      default:
        throw new ContractError(C, `${p}.properties.kind`, `unknown kind ${JSON.stringify(kind)} (expected position|track|forecast|cone)`);
    }
  });
  return { type: 'FeatureCollection', features };
}

// ---------- history / stats / hazards (lenient) ----------
export interface HistoryProps {
  id: string;
  name: string | null;
  year: number;
  max_wind_kt: number | null;
  category: string | null;
  imd_grade: string | null;
  /** genesis basin code (round 2; absent in older files) */
  basin: string | null;
  start: string;
  end: string;
}
export type HistoryGeometry = GeoJSON.LineString | GeoJSON.MultiLineString;
export type HistoryCollection = GeoJSON.FeatureCollection<HistoryGeometry, HistoryProps>;
/** All vertices of a history geometry (a track split at the antimeridian is a MultiLineString). */
export function historyVertices(g: HistoryGeometry): number[][] {
  return g.type === 'LineString' ? g.coordinates : g.coordinates.flat();
}

export function parseHistory(raw: unknown): HistoryCollection {
  const C = 'storms/history/*.geojson';
  const o = obj(C, '$', raw);
  if (o.type !== 'FeatureCollection') throw new ContractError(C, 'type', 'expected "FeatureCollection"');
  const features = arr(C, 'features', o.features).map((f, i) => {
    const p = `features[${i}]`;
    const fo = obj(C, p, f);
    const g = obj(C, `${p}.geometry`, fo.geometry);
    if (g.type !== 'LineString' && g.type !== 'MultiLineString') throw new ContractError(C, `${p}.geometry.type`, `expected LineString or MultiLineString, got ${JSON.stringify(g.type)}`);
    const props = obj(C, `${p}.properties`, fo.properties);
    return {
      type: 'Feature' as const,
      geometry: (g.type === 'LineString'
        ? { type: 'LineString' as const, coordinates: arr(C, `${p}.geometry.coordinates`, g.coordinates).map((c, j) => lonLat(C, `${p}.geometry.coordinates[${j}]`, c)) }
        : { type: 'MultiLineString' as const, coordinates: arr(C, `${p}.geometry.coordinates`, g.coordinates).map((part, k) => arr(C, `${p}.geometry.coordinates[${k}]`, part).map((c, j) => lonLat(C, `${p}.geometry.coordinates[${k}][${j}]`, c))) }) as HistoryGeometry,
      properties: {
        id: str(C, `${p}.properties.id`, props.id),
        name: typeof props.name === 'string' && props.name ? props.name : null,
        year: num(C, `${p}.properties.year`, props.year),
        max_wind_kt: nullableNum(C, `${p}.properties.max_wind_kt`, props.max_wind_kt),
        category: typeof props.category === 'string' ? props.category : null,
        imd_grade: typeof props.imd_grade === 'string' ? props.imd_grade : null,
        basin: typeof props.basin === 'string' ? props.basin : null,
        start: typeof props.start === 'string' ? props.start : '',
        end: typeof props.end === 'string' ? props.end : ''
      }
    };
  });
  return { type: 'FeatureCollection', features };
}

export interface BasinStats {
  annual: { year: number; storms: number; tropical_storm?: number; hurricane?: number; major?: number; ace?: number }[];
  monthly: { month: number; storms_per_year: number }[];
  notes: string;
}
export function parseStats(raw: unknown): BasinStats {
  const C = 'storms/stats/*.json';
  const o = obj(C, '$', raw);
  const annual = arr(C, 'annual', o.annual).map((a, i) => {
    const ao = obj(C, `annual[${i}]`, a);
    return {
      year: num(C, `annual[${i}].year`, ao.year),
      storms: num(C, `annual[${i}].storms`, ao.storms),
      tropical_storm: ao.tropical_storm === undefined ? undefined : num(C, `annual[${i}].tropical_storm`, ao.tropical_storm),
      hurricane: ao.hurricane === undefined ? undefined : num(C, `annual[${i}].hurricane`, ao.hurricane),
      major: ao.major === undefined ? undefined : num(C, `annual[${i}].major`, ao.major),
      ace: ao.ace === undefined ? undefined : num(C, `annual[${i}].ace`, ao.ace)
    };
  });
  const monthly = (Array.isArray(o.monthly) ? o.monthly : []).map((m, i) => {
    const mo = obj(C, `monthly[${i}]`, m);
    return { month: num(C, `monthly[${i}].month`, mo.month), storms_per_year: num(C, `monthly[${i}].storms_per_year`, mo.storms_per_year) };
  });
  return { annual, monthly, notes: typeof o.notes === 'string' ? o.notes : '' };
}

export type HazardKind = 'wildfire' | 'volcano' | 'quake' | 'flood' | 'storm' | 'other';
export interface HazardIndex {
  schema: number;
  generated: string;
  layers: Record<string, { count: number; source: string }>;
}
export function parseHazardIndex(raw: unknown): HazardIndex {
  const C = 'hazards/index.json';
  const o = obj(C, '$', raw);
  const layers: HazardIndex['layers'] = {};
  for (const [k, v] of Object.entries(obj(C, 'layers', o.layers))) {
    const lo = obj(C, `layers.${k}`, v);
    layers[k] = { count: num(C, `layers.${k}.count`, lo.count), source: typeof lo.source === 'string' ? lo.source : '' };
  }
  return { schema: num(C, 'schema', o.schema), generated: isoZ(C, 'generated', o.generated), layers };
}

/** Keep only well-formed Point features; hazards are best-effort. */
export function parseHazardPoints(raw: unknown): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const C = 'hazards/*.geojson';
  const o = obj(C, '$', raw);
  if (o.type !== 'FeatureCollection') throw new ContractError(C, 'type', 'expected "FeatureCollection"');
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const f of arr(C, 'features', o.features)) {
    if (!isObj(f) || !isObj(f.geometry) || f.geometry.type !== 'Point') continue;
    const c = f.geometry.coordinates;
    if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [c[0], c[1]] }, properties: isObj(f.properties) ? f.properties : {} });
  }
  return { type: 'FeatureCollection', features };
}
