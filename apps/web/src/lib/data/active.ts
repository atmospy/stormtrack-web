import type { ActiveStorms, ConeProps, Feature, ForecastProps, Line, Poly, PositionProps, Pt, TrackProps } from './contracts';

export interface StormBundle {
  id: string;
  position: Feature<Pt, PositionProps>;
  track?: Feature<Line, TrackProps>;
  forecast?: Feature<Line, ForecastProps>;
  cone?: Feature<Poly, ConeProps>;
}

/** Forecast features carry no id in CONTRACTS section 2, so attach them to the storm whose position is closest. */
export function nearestStormId(active: ActiveStorms, c: number[]): string {
  let best = '';
  let bd = Infinity;
  for (const f of active.features) {
    if (f.properties.kind !== 'position') continue;
    const [x, y] = (f.geometry as Pt).coordinates;
    const d = (x - c[0]!) ** 2 + (y - c[1]!) ** 2;
    if (d < bd) {
      bd = d;
      best = f.properties.id;
    }
  }
  return best;
}

export function groupStorms(active: ActiveStorms): Map<string, StormBundle> {
  const m = new Map<string, StormBundle>();
  for (const f of active.features) if (f.properties.kind === 'position') m.set(f.properties.id, { id: f.properties.id, position: f as StormBundle['position'] });
  for (const f of active.features) {
    const p = f.properties;
    if (p.kind === 'track') {
      const b = m.get(p.id);
      if (b) b.track = f as StormBundle['track'];
    } else if (p.kind === 'forecast') {
      const id = p.id ?? nearestStormId(active, (f.geometry as Line).coordinates[0]!);
      const b = m.get(id);
      if (b) b.forecast = f as StormBundle['forecast'];
    } else if (p.kind === 'cone') {
      const b = m.get(p.id);
      if (b) b.cone = f as StormBundle['cone'];
    }
  }
  return m;
}

/** [west, south, east, north] over all geometry of a storm (track + forecast + cone). */
export function stormBounds(b: StormBundle): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  const add = (c: number[]) => {
    w = Math.min(w, c[0]!); e = Math.max(e, c[0]!); s = Math.min(s, c[1]!); n = Math.max(n, c[1]!);
  };
  add(b.position.geometry.coordinates);
  b.track?.geometry.coordinates.forEach(add);
  b.forecast?.geometry.coordinates.forEach(add);
  const ring = (b.cone?.geometry.coordinates as number[][][] | undefined)?.[0];
  ring?.forEach(add);
  if (e - w < 2) { w -= 1; e += 1; }
  if (n - s < 2) { s -= 1; n += 1; }
  return [w, s, e, n];
}
