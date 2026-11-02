import type { ActiveStorms } from '#lib/data/contracts';

export interface TimedPosition {
  lon: number;
  lat: number;
  /** interpolated wind (kt); null when the forecast has no wind at the bracketing points */
  wind: number | null;
  /** true when the position comes from the forecast rather than the observation */
  forecast: boolean;
}

/**
 * Where an active storm is at `validMs`: its observed position up to the forecast's initial time, then moved
 * along the agency forecast track (linear in time between forecast points, shortest way across the antimeridian),
 * and held at the last forecast point after the forecast ends. Null when the storm has no forecast.
 */
export function positionAt(active: ActiveStorms, id: string, validMs: number): TimedPosition | null {
  const f = active.features.find((x) => x.properties.kind === 'forecast' && x.properties.id === id);
  if (!f || f.properties.kind !== 'forecast' || f.geometry.type !== 'LineString') return null;
  const fp = f.properties;
  const initMs = Date.parse(fp.init);
  if (!Number.isFinite(initMs)) return null;
  const pts: { t: number; lon: number; lat: number; w: number | null }[] = [];
  f.geometry.coordinates.forEach((c, i) => {
    const tau = fp.taus[i];
    if (tau === null || tau === undefined) return; // interpolated antimeridian vertex: no lead time of its own
    pts.push({ t: initMs + tau * 3_600_000, lon: c[0]!, lat: c[1]!, w: fp.wind_kt[i] ?? null });
  });
  if (pts.length < 2) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (validMs <= first.t) return { lon: first.lon, lat: first.lat, wind: first.w, forecast: false };
  if (validMs >= last.t) return { lon: last.lon, lat: last.lat, wind: last.w, forecast: true };
  let k = 0;
  while (pts[k + 1]!.t < validMs) k++;
  const a = pts[k]!;
  const b = pts[k + 1]!;
  const u = (validMs - a.t) / (b.t - a.t);
  let dLon = b.lon - a.lon;
  if (dLon > 180) dLon -= 360;
  else if (dLon < -180) dLon += 360;
  let lon = a.lon + dLon * u;
  if (lon > 180) lon -= 360;
  else if (lon < -180) lon += 360;
  const wind = a.w !== null && b.w !== null ? a.w + (b.w - a.w) * u : null;
  return { lon, lat: a.lat + (b.lat - a.lat) * u, wind, forecast: true };
}
