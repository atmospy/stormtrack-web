import { describe, expect, it } from 'vitest';
import { demoFlashes, demoIndex, demoRecent, demoStrikes } from './demo';
import { LightningPlayer } from './player';

const T = 1_793_560_800_000;
describe('demo feed', () => {
  it('is deterministic, sorted, in range, unique ids, mixed energies, India cluster has none', () => {
    const a = demoStrikes(T, T + 120_000);
    expect(a).toEqual(demoStrikes(T, T + 120_000));
    expect(a.length).toBeGreaterThan(200);
    for (let i = 1; i < a.length; i++) expect(a[i]!.t_ms).toBeGreaterThanOrEqual(a[i - 1]!.t_ms);
    expect(a.every((s) => s.t_ms >= T && s.t_ms < T + 120_000 && Math.abs(s.lat) < 90 && Math.abs(s.lon) <= 180)).toBe(true);
    expect(new Set(a.map((s) => s.id)).size).toBeGreaterThan(a.length * 0.99);
    const india = a.filter((s) => s.src === 1);
    expect(india.length).toBeGreaterThan(0);
    expect(india.every((s) => s.energy_fj === null && s.lon > 66 && s.lon < 100)).toBe(true);
    const e = a.filter((s) => s.src === 0).map((s) => s.energy_fj!);
    expect(Math.max(...e)).toBeGreaterThan(5 * Math.min(...e));
  });
  it('windows are consistent: splitting a range gives the same strikes', () => {
    const whole = demoStrikes(T, T + 60_000).map((s) => s.id);
    const parts = [...demoStrikes(T, T + 25_000), ...demoStrikes(T + 25_000, T + 60_000)].map((s) => s.id);
    expect(parts).toEqual(whole);
  });
  it('recent.json-shaped lumps overlap across publishes and de-duplicate in the player', () => {
    let now = T + 300_000;
    const out: string[] = [];
    const p = new LightningPlayer({ delayMs: 75_000, now: () => now, onStrike: (s) => out.push(s.id) });
    const first = demoRecent(now);
    const added1 = p.push(first.strikes);
    now += 20_000;
    const second = demoRecent(now);
    const added2 = p.push(second.strikes);
    expect(added1).toBeGreaterThan(0);
    expect(added2).toBeLessThan(second.strikes.length); // overlap was dropped
    now += 200_000;
    p.tick();
    expect(new Set(out).size).toBe(out.length);
  });
  it('backlog and index', () => {
    const f = demoFlashes(T, T - 1000, 10);
    expect(f.n).toBeGreaterThan(0);
    expect(demoIndex(T).live).toEqual({ delay_s: 75, poll_s: 15 });
  });
});
