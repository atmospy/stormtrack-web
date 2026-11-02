/** Radiosonde telemetry from the SondeHub network (amateur receivers; CC BY-SA 2.0). */

export interface SondeFix {
  serial: string;
  /** ms since epoch, the time the sonde reported */
  t: number;
  lon: number;
  lat: number;
  /** metres above sea level */
  alt: number;
  type: string;
  /** vertical speed m/s, negative while falling */
  velV: number | null;
  temp: number | null;
  humidity: number | null;
  /** receiver callsign */
  by: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One telemetry packet to a fix, or null if it lacks a usable position or time. */
export function parseSonde(raw: unknown): SondeFix | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lat = num(r.lat), lon = num(r.lon), alt = num(r.alt);
  const t = typeof r.datetime === 'string' ? Date.parse(r.datetime) : NaN;
  if (typeof r.serial !== 'string' || !r.serial || lat === null || lon === null || alt === null || !Number.isFinite(t)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0) || alt < -500 || alt > 60_000) return null;
  return {
    serial: r.serial,
    t,
    lon,
    lat,
    alt,
    type: typeof r.type === 'string' ? r.type : '',
    velV: num(r.vel_v),
    temp: num(r.temp),
    humidity: num(r.humidity),
    by: typeof r.uploader_callsign === 'string' ? r.uploader_callsign : ''
  };
}

/** Latest fix and a short trail per sonde. */
export class SondeBook {
  readonly last = new Map<string, SondeFix>();
  readonly trail = new Map<string, [number, number, number][]>();
  constructor(readonly maxTrail = 300, readonly maxAgeMs = 2 * 3_600_000) {}

  add(f: SondeFix): void {
    const prev = this.last.get(f.serial);
    if (prev && f.t < prev.t) return; // out of order or duplicate
    this.last.set(f.serial, f);
    const tr = this.trail.get(f.serial) ?? [];
    if (!prev || f.t > prev.t) tr.push([f.lon, f.lat, f.alt]);
    if (tr.length > this.maxTrail) tr.splice(0, tr.length - this.maxTrail);
    this.trail.set(f.serial, tr);
  }

  /** Forget sondes not heard from for `maxAgeMs` (landed or out of range). */
  prune(nowMs: number): void {
    for (const [k, f] of this.last) {
      if (nowMs - f.t > this.maxAgeMs) {
        this.last.delete(k);
        this.trail.delete(k);
      }
    }
  }
}

/** GeoJSON for the map: one point per sonde, one line per sonde with at least two fixes. */
export function sondeGeoJSON(book: SondeBook, nowMs: number): { points: GeoJSON.FeatureCollection; lines: GeoJSON.FeatureCollection } {
  const points: GeoJSON.Feature[] = [];
  const lines: GeoJSON.Feature[] = [];
  for (const [serial, f] of book.last) {
    const falling = f.velV !== null && f.velV < -2;
    points.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      properties: { serial, alt: Math.round(f.alt), type: f.type, falling, temp: f.temp, humidity: f.humidity, velV: f.velV, ageS: Math.round((nowMs - f.t) / 1000), by: f.by }
    });
    const tr = book.trail.get(serial);
    if (tr && tr.length > 1) lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: tr.map((p) => [p[0], p[1]]) }, properties: { serial } });
  }
  return { points: { type: 'FeatureCollection', features: points }, lines: { type: 'FeatureCollection', features: lines } };
}
