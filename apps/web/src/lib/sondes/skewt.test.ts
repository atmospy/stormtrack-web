import { describe, expect, it } from 'vitest';
import { barbPath, buildProfile, dewPoint, dryAdiabat, frameFor, hydrostaticPressure, isaPressure, project, topPressure, windFrom, yFrac } from './skewt';

const pk = (o: Record<string, unknown>) => ({ datetime: '2026-11-02T19:00:00Z', pressure: 900, temp: 10, humidity: 50, alt: 1000, vel_h: 5, heading: 90, ...o });

describe('dewPoint', () => {
  it('matches reference values', () => {
    expect(dewPoint(20, 50)!).toBeCloseTo(9.3, 1);
    expect(dewPoint(25, 100)!).toBeCloseTo(25, 1);
    expect(dewPoint(0, 80)!).toBeCloseTo(-3.0, 0);
  });
  it('rejects a missing or impossible humidity', () => {
    expect(dewPoint(10, 0)).toBeNull();
    expect(dewPoint(10, 120)).toBeNull();
  });
});

describe('windFrom', () => {
  it('flips the travel heading to the direction the wind comes from', () => {
    expect(windFrom(10, 90)).toEqual({ ws: 10, wd: 270 });
    expect(windFrom(10, 300)).toEqual({ ws: 10, wd: 120 });
    expect(windFrom(null, 90)).toBeNull();
  });
});

describe('buildProfile', () => {
  const mk = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, pk({ datetime: new Date(Date.UTC(2026, 10, 2, 19, 0, i * 10)).toISOString(), pressure: 1000 - i * 5, temp: 20 - i * 0.6, alt: i * 50 })]));
  it('reads the {serial:{time:packet}} shape, thins by pressure and keeps order', () => {
    const p = buildProfile({ S1: mk(100) }, 'S1')!;
    expect(p.p.length).toBeGreaterThan(50);
    expect(p.p).toEqual([...p.p].sort((a, b) => b - a));
    expect(p.ascending).toBe(true);
    expect(p.td[0]).not.toBeNull();
  });
  it('stops at the highest point, so the descent is not drawn', () => {
    const asc = Array.from({ length: 20 }, (_, i) => pk({ datetime: new Date(Date.UTC(2026, 10, 2, 19, 0, i)).toISOString(), pressure: 1000 - i * 20, alt: i * 500, temp: 20 - i }));
    const desc = Array.from({ length: 20 }, (_, i) => pk({ datetime: new Date(Date.UTC(2026, 10, 2, 19, 1, i)).toISOString(), pressure: 600 + i * 20, alt: 9000 - i * 450, temp: -2 + i }));
    const p = buildProfile([...asc, ...desc], 'x')!;
    expect(p.maxAlt).toBe(9500);
    expect(Math.min(...p.p)).toBe(620);
    expect(p.ascending).toBe(false);
  });
  it('ignores packets without pressure or with impossible temperatures; null when too few', () => {
    expect(buildProfile([pk({ pressure: null }), pk({}), pk({ temp: 200 })], 'x')).toBeNull();
  });
  it('drops the dew point above 250 hPa where the humidity sensor is meaningless', () => {
    const rows = [0, 1, 2, 3].map((i) => pk({ datetime: new Date(Date.UTC(2026, 10, 2, 19, 0, i)).toISOString(), pressure: 240 - i * 10, temp: -50, alt: 11000 + i * 100 }));
    expect(buildProfile(rows, 'x')!.td.every((v) => v === null)).toBe(true);
  });
});

describe('geometry', () => {
  const f = frameFor(300, 340, 167);
  it('puts the bottom pressure at the bottom and the top pressure at the top', () => {
    expect(f.pTop).toBe(100);
    expect(yFrac(f, 1050)).toBeCloseTo(0, 6);
    expect(yFrac(f, 100)).toBeCloseTo(1, 6);
    expect(project(f, 0, 1050).y).toBeCloseTo(340, 6);
    expect(project(f, 0, 100).y).toBeCloseTo(0, 6);
  });
  it('leans isotherms to the right with height and keeps equal temperatures on one line', () => {
    expect(project(f, 0, 500).x).toBeGreaterThan(project(f, 0, 1000).x);
    expect(project(f, 10, 700).x - project(f, 0, 700).x).toBeCloseTo((10 / 90) * 300, 6);
  });
  it('keeps -80 degC at 100 hPa on the plot', () => {
    const x = project(f, -80, 100).x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(300);
  });
  it('picks a top pressure no lower than the data needs', () => {
    expect(topPressure(167)).toBe(100);
    expect(topPressure(7)).toBe(5);
    expect(topPressure(600)).toBe(500);
  });
  it('dry adiabats pass 1000 hPa at theta - 273.15', () => {
    expect(dryAdiabat(300, 1000)).toBeCloseTo(26.85, 2);
    expect(dryAdiabat(300, 500)).toBeLessThan(dryAdiabat(300, 1000));
  });
});

describe('estimated pressure', () => {
  const isaT = (z: number) => 15 - 0.0065 * z;
  it('ISA surface pressure and a known height', () => {
    expect(isaPressure(0)).toBeCloseTo(1013.25, 2);
    expect(isaPressure(5000)).toBeCloseTo(540.2, 0);
  });
  it('hydrostatic integration through an ISA column matches ISA within 1 %', () => {
    const alt = Array.from({ length: 111 }, (_, i) => i * 100); // 0 to 11 km
    const p = hydrostaticPressure(alt, alt.map(isaT));
    for (const z of [2000, 5000, 9000, 11000]) {
      const got = p[z / 100]!, want = isaPressure(z);
      expect(Math.abs(got - want) / want).toBeLessThan(0.01);
    }
  });
  it('builds a profile for a sonde that sends no pressure and says so', () => {
    const rows = Array.from({ length: 200 }, (_, i) => pk({ datetime: new Date(Date.UTC(2026, 10, 2, 19, 0, i)).toISOString(), pressure: null, alt: i * 60, temp: 15 - 0.0065 * i * 60 }));
    const pr = buildProfile(rows, 'x')!;
    expect(pr.pressureEstimated).toBe(true);
    expect(pr.p[0]).toBeGreaterThan(pr.p[pr.p.length - 1]!);
    expect(pr.p[pr.p.length - 1]!).toBeGreaterThan(100);
  });
  it('uses reported pressure when the sonde sends it', () => {
    const rows = Array.from({ length: 20 }, (_, i) => pk({ datetime: new Date(Date.UTC(2026, 10, 2, 19, 0, i)).toISOString(), pressure: 1000 - i * 10, alt: i * 100 }));
    expect(buildProfile(rows, 'x')!.pressureEstimated).toBe(false);
  });
});

describe('barbPath', () => {
  it('is a dot for calm', () => {
    expect(barbPath(0)).toContain('a2 2');
  });
  it('draws a half barb for 5 kt, a full barb for 10 kt and a pennant for 50 kt', () => {
    expect(barbPath(5)).toMatch(/L4 /);
    expect(barbPath(5)).not.toMatch(/L8 /);
    expect(barbPath(10)).toMatch(/L8 /);
    const flag = barbPath(50);
    expect(flag).toMatch(/L8 [-\d.]+L0 /);
    expect(barbPath(60).length).toBeGreaterThan(flag.length);
  });
});
