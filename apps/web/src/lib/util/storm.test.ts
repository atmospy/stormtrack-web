import { describe, expect, it } from 'vitest';
import { beaufort, categoryFromLabel, categoryFromWind, colorFor, compass, distBearing, windFromDeg, CATEGORIES } from './storm';

describe('categoryFromWind (Saffir-Simpson, kt)', () => {
  it.each([[null, 'TD'], [20, 'TD'], [33, 'TD'], [34, 'TS'], [63, 'TS'], [64, 'C1'], [82, 'C1'], [83, 'C2'], [95, 'C2'], [96, 'C3'], [112, 'C3'], [113, 'C4'], [136, 'C4'], [137, 'C5'], [180, 'C5']])('%s kt -> %s', (kt, label) => {
    expect(categoryFromWind(kt as number | null).label).toBe(label);
  });
});
describe('categoryFromLabel', () => {
  it('maps contract labels', () => {
    expect(categoryFromLabel('TD').rank).toBe(0);
    expect(categoryFromLabel('TS').rank).toBe(1);
    expect(categoryFromLabel('C3').rank).toBe(4);
    expect(categoryFromLabel('H5').label).toBe('C5');
  });
  it('falls back to wind for unknown labels', () => {
    expect(categoryFromLabel('???', 100).label).toBe('C3');
    expect(categoryFromLabel(null, 40).label).toBe('TS');
  });
  it('colours are distinct and stable', () => {
    expect(new Set(CATEGORIES.map((c) => c.color)).size).toBe(7);
    expect(colorFor('C1')).toBe('#ffe14d');
  });
});
describe('wind helpers', () => {
  it('meteorological direction', () => {
    expect(windFromDeg(0, -10)).toBeCloseTo(0); // blowing south = from north
    expect(windFromDeg(-10, 0)).toBeCloseTo(90); // blowing west = from east
    expect(windFromDeg(10, 0)).toBeCloseTo(270); // westerly
    expect(windFromDeg(0, 10)).toBeCloseTo(180);
  });
  it('compass + beaufort', () => {
    expect(compass(0)).toBe('N');
    expect(compass(225)).toBe('SW');
    expect(compass(359)).toBe('N');
    expect(beaufort(0).n).toBe(0);
    expect(beaufort(15).n).toBe(7);
    expect(beaufort(40).n).toBe(12);
  });
  it('distance and bearing', () => {
    const d = distBearing(0, 0, 0, 1);
    expect(d.km).toBeCloseTo(111.2, 0);
    expect(d.bearing).toBeCloseTo(0);
    expect(distBearing(0, 0, 1, 0).bearing).toBeCloseTo(90);
  });
});
