import { describe, expect, it } from 'vitest';
import { parseRecent, type Strike } from '#lib/data/lightning';
import { LightningPlayer } from './player';

const strike = (id: string, t_ms: number, extra: Partial<Strike> = {}): Strike => ({ id, t_ms, lon: 0, lat: 0, energy_fj: 1, src: 0, ...extra });
const T = 1_793_560_800_000;

function make(delayMs = 90_000, opts: { maxLateMs?: number; idTtlMs?: number } = {}) {
  let now = T;
  const played: { id: string; late: number }[] = [];
  const p = new LightningPlayer({ delayMs, now: () => now, onStrike: (s, late) => played.push({ id: s.id, late }), ...opts });
  return { p, played, at: (t: number) => (now = t), advance: (d: number) => (now += d) };
}

describe('LightningPlayer', () => {
  it('plays strikes at their own timestamps, delay_s behind real time, in time order', () => {
    const { p, played, at } = make(90_000);
    p.push([strike('c', T + 3000), strike('a', T + 1000), strike('b', T + 2000)]); // arrives out of order
    at(T + 90_000 + 500);
    expect(p.tick()).toBe(0);
    at(T + 90_000 + 1000);
    expect(p.tick()).toBe(1);
    at(T + 90_000 + 2500);
    p.tick();
    expect(played.map((x) => x.id)).toEqual(['a', 'b']);
    expect(played[1]!.late).toBe(500);
    at(T + 200_000);
    p.tick();
    expect(played.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(p.pending).toBe(0);
  });
  it('de-duplicates by id across overlapping polls', () => {
    const { p, played, at } = make(0);
    expect(p.push([strike('a', T + 100), strike('b', T + 200)])).toBe(2);
    expect(p.push([strike('b', T + 200), strike('c', T + 300)])).toBe(1);
    expect(p.stats.duplicates).toBe(1);
    at(T + 1000);
    p.tick();
    expect(p.push([strike('a', T + 100)])).toBe(0); // already played: still remembered
    p.tick();
    expect(played.map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('drops strikes that are already too old when they arrive (late batch after a stall)', () => {
    const { p, played, at } = make(10_000, { maxLateMs: 5000 });
    at(T + 100_000);
    p.push([strike('old', T + 50_000), strike('ok', T + 88_000)]);
    expect(p.stats.dropped).toBe(1);
    p.tick();
    expect(played.map((x) => x.id)).toEqual(['ok']);
  });
  it('a fixed delay makes a whole batch arrive before it is played', () => {
    const { p, played, at } = make(90_000);
    // strike happened at T+10s, only published (and polled) at T+60s: still 30 s before it is due
    at(T + 60_000);
    p.push([strike('late-published', T + 10_000)]);
    at(T + 99_000);
    p.tick();
    expect(played).toHaveLength(0);
    at(T + 100_000);
    p.tick();
    expect(played.map((x) => x.id)).toEqual(['late-published']);
  });
  it('forgets old ids after the ttl and can be reset', () => {
    const { p, at } = make(0, { idTtlMs: 1000 });
    p.push([strike('a', T)]);
    at(T + 5000);
    p.push([strike('z', T + 5000)]); // triggers pruning
    expect(p.push([strike('a', T + 5000)])).toBe(1); // pruned id counts as new again (and is queued)
    p.reset();
    expect(p.pending).toBe(0);
  });
  it('keeps the queue sorted when many strikes share a timestamp', () => {
    const { p, played, at } = make(0);
    p.push([strike('1', T + 10), strike('2', T + 10), strike('0', T + 5), strike('3', T + 10)]);
    at(T + 20);
    p.tick();
    expect(played.map((x) => x.id)).toEqual(['0', '1', '2', '3']);
  });
});

describe('lightning/recent.json', () => {
  const ok = { schema: 1, generated: '2026-11-01T19:00:00Z', window_s: 90, cols: ['id', 't_ms', 'lon', 'lat', 'energy_fj', 'src'], rows: [['a1b2c3d4', T, -84.12, 29.4, 310.0, 0], ['ffff0000', T + 5, 85.1234, 22.1, null, 1]] };
  it('parses by column name, with null energy', () => {
    const r = parseRecent(ok);
    expect(r.strikes[1]).toEqual({ id: 'ffff0000', t_ms: T + 5, lon: 85.1234, lat: 22.1, energy_fj: null, src: 1 });
    const reordered = parseRecent({ ...ok, cols: ['t_ms', 'id', 'lat', 'lon'], rows: [[T, 'x', 5, 6]] });
    expect(reordered.strikes[0]).toMatchObject({ id: 'x', lat: 5, lon: 6, src: 0, energy_fj: null });
  });
  it('explains violations', () => {
    expect(() => parseRecent({ ...ok, schema: 2 })).toThrow(/unsupported schema 2/);
    expect(() => parseRecent({ ...ok, cols: ['id', 'lon'] })).toThrow(/missing required column "t_ms"/);
    expect(() => parseRecent({ ...ok, rows: [['a', 12345, 0, 0]] })).toThrow(/expected unix milliseconds/);
    expect(() => parseRecent({ ...ok, rows: [['', T, 0, 0]] })).toThrow(/rows\[0\]\.id/);
    expect(() => parseRecent({ ...ok, rows: [['a', T, 200, 0]] })).toThrow(/out of range/);
  });
});
