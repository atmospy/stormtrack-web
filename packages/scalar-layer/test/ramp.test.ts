import { describe, expect, it } from 'vitest';
import { SCALAR_RAMPS, buildRampLUT, rampColorAt } from '../src/index.js';

describe('ramps', () => {
  it('temperature is diverging around 0 degC: blue cold, near-white freezing, orange/red warm', () => {
    const r = SCALAR_RAMPS.temperature;
    const cold = rampColorAt(r, [-40, 50], -25);
    const zero = rampColorAt(r, [-40, 50], 0);
    const hot = rampColorAt(r, [-40, 50], 35);
    expect(cold[2]).toBeGreaterThan(cold[0]); // blue-dominant
    expect(hot[0]).toBeGreaterThan(hot[2]); // red-dominant
    expect(Math.min(zero[0], zero[1], zero[2])).toBeGreaterThan(200); // light neutral
    expect(zero[3]).toBe(255);
  });

  it('stops are absolute: the same value gets the same colour whatever the frame range', () => {
    const a = rampColorAt(SCALAR_RAMPS.temperature, [-60, 60], 20);
    const b = rampColorAt(SCALAR_RAMPS.temperature, [-40, 50], 20);
    for (let i = 0; i < 4; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(3);
  });

  it('values outside the stops clamp to the end colours', () => {
    const lut = buildRampLUT(SCALAR_RAMPS.pressure, [900, 1100]);
    expect(Array.from(lut.slice(0, 4))).toEqual(Array.from(lut.slice(4, 8)));
    const n = lut.length;
    expect(Array.from(lut.slice(n - 4))).toEqual(Array.from(lut.slice(n - 8, n - 4)));
  });

  it('precipitation is transparent below 0.1 mm and opaque-ish for heavy rain (linear and sqrt LUT)', () => {
    for (const sq of [false, true]) {
      expect(rampColorAt(SCALAR_RAMPS.precipitation, [0, 100], 0.05, sq)[3]).toBe(0);
      expect(rampColorAt(SCALAR_RAMPS.precipitation, [0, 100], 0, sq)[3]).toBe(0);
      expect(rampColorAt(SCALAR_RAMPS.precipitation, [0, 100], 10, sq)[3]).toBeGreaterThan(200);
    }
    // sqrt LUT resolves 0.2..1 mm into many texels, linear LUT into ~3
    const lin = buildRampLUT(SCALAR_RAMPS.precipitation, [0, 100], false);
    const sqr = buildRampLUT(SCALAR_RAMPS.precipitation, [0, 100], true);
    const distinct = (l: Uint8Array) => new Set(Array.from({ length: 512 }, (_, i) => `${l[i * 4]},${l[i * 4 + 3]}`).values()).size;
    expect(distinct(sqr)).toBeGreaterThan(distinct(lin));
  });

  it('viridis is normalised: ends are dark purple and yellow whatever the range', () => {
    const lo = rampColorAt(SCALAR_RAMPS.viridis, [930, 1070], 930);
    const hi = rampColorAt(SCALAR_RAMPS.viridis, [930, 1070], 1070);
    expect(Math.abs(lo[0]! - 0x44)).toBeLessThan(3);
    expect(Math.abs(hi[0]! - 0xfd)).toBeLessThan(3);
    expect(Math.abs(hi[1]! - 0xe7)).toBeLessThan(3);
  });

  it('LUT has the expected size and rejects empty ramps', () => {
    expect(buildRampLUT(SCALAR_RAMPS.pressure, [900, 1100], false, 256)).toHaveLength(1024);
    expect(() => buildRampLUT({ stops: [] }, [0, 1])).toThrow();
  });
});
