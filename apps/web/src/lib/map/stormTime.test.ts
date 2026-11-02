import { describe, expect, it } from 'vitest';
import type { ActiveStorms } from '#lib/data/contracts';
import { positionAt } from './stormTime';

const H = 3_600_000;
const INIT = Date.parse('2026-11-02T06:00:00Z');
const mk = (coords: number[][], taus: (number | null)[], wind: (number | null)[]): ActiveStorms =>
  ({
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { kind: 'forecast', id: 'X', init: '2026-11-02T06:00:00Z', tech: 'JTWC', taus, wind_kt: wind, category: wind.map(() => 'TS') }
      }
    ]
  }) as unknown as ActiveStorms;

describe('positionAt', () => {
  const a = mk([[140, 20], [142, 24], [146, 30]], [0, 12, 36], [70, 80, 60]);
  it('holds the observed point before and at the forecast start', () => {
    expect(positionAt(a, 'X', INIT - 5 * H)).toMatchObject({ lon: 140, lat: 20, forecast: false });
    expect(positionAt(a, 'X', INIT)).toMatchObject({ lon: 140, lat: 20 });
  });
  it('interpolates linearly in time between forecast points', () => {
    const p = positionAt(a, 'X', INIT + 6 * H)!;
    expect(p.lon).toBeCloseTo(141);
    expect(p.lat).toBeCloseTo(22);
    expect(p.wind).toBeCloseTo(75);
    expect(p.forecast).toBe(true);
    const q = positionAt(a, 'X', INIT + 24 * H)!; // halfway between tau 12 and 36
    expect(q.lon).toBeCloseTo(144);
    expect(q.lat).toBeCloseTo(27);
  });
  it('holds the last point after the forecast ends', () => {
    expect(positionAt(a, 'X', INIT + 200 * H)).toMatchObject({ lon: 146, lat: 30 });
  });
  it('goes the short way across the antimeridian', () => {
    const b = mk([[179, 10], [-179, 12]], [0, 12], [50, 50]);
    expect(Math.abs(positionAt(b, 'X', INIT + 6 * H)!.lon)).toBeCloseTo(180, 5);
  });
  it('ignores vertices without a lead time and returns null with no forecast', () => {
    const c = mk([[170, 0], [180, 1], [-170, 2]], [0, null, 24], [40, null, 60]);
    expect(positionAt(c, 'X', INIT + 12 * H)!.lon).toBeCloseTo(180, 5);
    expect(positionAt(a, 'NOPE', INIT)).toBeNull();
  });
});
