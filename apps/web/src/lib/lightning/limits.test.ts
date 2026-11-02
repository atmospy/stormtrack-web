import { describe, expect, it } from 'vitest';
import { AREA_BUDGET_PX2, Announcer, FlashBudget, RateCounter, coreAreaPx2, energySize } from './limits';

describe('FlashBudget', () => {
  it('lit core area never exceeds the budget however many strikes arrive at once', () => {
    const b = new FlashBudget();
    let flashes = 0;
    for (let i = 0; i < 5000; i++) if (b.decide(1, i, 1000) === 'flash') flashes++;
    expect(b.litArea(1000)).toBeLessThanOrEqual(AREA_BUDGET_PX2);
    expect(flashes).toBeLessThanOrEqual(300);
    expect(b.stats.dim).toBe(5000 - flashes);
  });
  it('merges strikes in the same pixel cell within a short time', () => {
    const b = new FlashBudget();
    expect(b.decide(0.5, 7, 0)).toBe('flash');
    expect(b.decide(0.5, 7, 100)).toBe('dim');
    expect(b.decide(0.5, 7, 400)).toBe('flash');
  });
  it('reduced mode never produces a flash and is rate limited', () => {
    const b = new FlashBudget({ softPerSec: 10 });
    b.reduced = true;
    const kinds = Array.from({ length: 100 }, (_, i) => b.decide(1, i, 5000));
    expect(kinds).not.toContain('flash');
    expect(kinds.filter((k) => k === 'soft').length).toBe(10);
    expect(b.decide(1, 999, 6200)).toBe('soft');
  });
  it('frees budget as flashes expire', () => {
    const b = new FlashBudget({ maxConcurrent: 2 });
    expect(b.decide(0.5, 1, 0)).toBe('flash');
    expect(b.decide(0.5, 2, 0)).toBe('flash');
    expect(b.decide(0.5, 3, 0)).toBe('dim');
    expect(b.decide(0.5, 4, 2000)).toBe('flash');
  });
  it('energy sizes', () => {
    expect(energySize(null)).toBe(0.35);
    expect(energySize(3000)).toBeGreaterThan(energySize(10));
    expect(coreAreaPx2(1)).toBeLessThan(160);
  });
});

describe('RateCounter / Announcer', () => {
  it('counts per source in a rolling minute', () => {
    const r = new RateCounter(2);
    r.add(0, 0); r.add(0, 30_000); r.add(1, 50_000);
    expect(r.counts(55_000)).toEqual([2, 1]);
    expect(r.counts(80_000)).toEqual([1, 1]);
    expect(r.counts(200_000)).toEqual([0, 0]);
  });
  it('announces rarely and only on notable change', () => {
    const a = new Announcer(30_000);
    expect(a.next(0, 12, 'near the map centre')).toBe('12 lightning strikes in the last minute near the map centre');
    expect(a.next(10_000, 40, 'x')).toBeNull(); // too soon
    expect(a.next(40_000, 13, 'x')).toBeNull(); // not notable
    expect(a.next(80_000, 30, 'x')).toContain('30 lightning strikes');
  });
});
