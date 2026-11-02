import { describe, expect, it } from 'vitest';
import { RecentPoller, feedHealth } from './poller';
import { feedBadge } from './status';

const body = (gen: string, rows: unknown[][]) => JSON.stringify({ schema: 1, generated: gen, window_s: 180, cols: ['id', 't_ms', 'lon', 'lat', 'energy_fj', 'src'], rows });
const resp = (b: string, status = 200, ct = 'application/json') => new Response(b, { status, headers: { 'content-type': ct } });

function rig(handler: () => Promise<Response>, opts: { hidden?: () => boolean } = {}) {
  let t = 1_793_560_800_000;
  const timers: { fn: () => void; ms: number }[] = [];
  const got: number[] = [];
  const errs: number[] = [];
  const p = new RecentPoller({
    url: '/x/recent.json', pollMs: 15_000, now: () => t, rand: () => 0.5,
    fetchFn: (async () => handler()) as unknown as typeof fetch,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => { timers.length = 0; },
    onRecent: (r) => got.push(r.strikes.length), onError: (e) => errs.push(e.errors), isHidden: opts.hidden
  });
  const fire = async () => { const x = timers.pop(); x?.fn(); await new Promise((r) => setTimeout(r, 0)); };
  return { p, timers, got, errs, fire, adv: (ms: number) => (t += ms) };
}

describe('RecentPoller', () => {
  it('polls, delivers, and schedules the next poll one interval later', async () => {
    const r = rig(async () => resp(body('2026-11-01T19:00:00Z', [['a', 1_793_560_800_000, 1, 2, 3, 0]])));
    r.p.start();
    await r.fire();
    expect(r.got).toEqual([1]);
    expect(r.timers[0]!.ms).toBeGreaterThanOrEqual(13_500);
    expect(r.timers[0]!.ms).toBeLessThanOrEqual(16_500);
  });
  it('never stacks requests', async () => {
    let release!: () => void;
    const r = rig(() => new Promise<Response>((res) => (release = () => res(resp(body('2026-11-01T19:00:00Z', []))))));
    r.p.start();
    r.timers.pop()!.fn();
    void r.p.poll(); void r.p.poll();
    expect(r.p.requests).toBe(1);
    release();
    await new Promise((x) => setTimeout(x, 0));
    expect(r.p.inflight).toBe(false);
  });
  it('backs off exponentially on errors and resets on success', async () => {
    let fail = true;
    const r = rig(async () => (fail ? resp('', 503) : resp(body('2026-11-01T19:00:00Z', []))));
    r.p.start();
    await r.fire();
    const d1 = r.timers[0]!.ms;
    await r.fire();
    const d2 = r.timers[0]!.ms;
    expect(d2).toBeGreaterThan(d1);
    expect(r.errs).toEqual([1, 2]);
    fail = false;
    await r.fire();
    expect(r.p.errors).toBe(0);
    expect(r.timers[0]!.ms).toBeLessThan(d2);
  });
  it('treats a 404 or an HTML fallback as "not published" and slows right down', async () => {
    const r = rig(async () => resp('<html>', 200, 'text/html'));
    r.p.start();
    await r.fire();
    expect(r.p.missing).toBe(true);
    expect(r.timers[0]!.ms).toBeGreaterThanOrEqual(60_000);
  });
  it('does not fetch while hidden and polls at once on resume', async () => {
    let hidden = true;
    const r = rig(async () => resp(body('2026-11-01T19:00:00Z', [])), { hidden: () => hidden });
    r.p.start();
    await r.fire();
    expect(r.p.requests).toBe(0);
    hidden = false;
    r.p.resume();
    expect(r.timers[0]!.ms).toBe(0);
    await r.fire();
    expect(r.p.requests).toBe(1);
  });
  it('treats 304 as success without data', async () => {
    const r = rig(async () => new Response(null, { status: 304 }));
    r.p.start();
    await r.fire();
    expect(r.p.errors).toBe(0);
    expect(r.p.lastOkAt).not.toBeNull();
  });
});

describe('feedHealth / badge', () => {
  const base = { now: 1_000_000, generatedMs: 1_000_000 - 20_000, indexStale: false, lastOkAt: 999_000, errors: 0, missing: false, pollMs: 15_000 };
  it('live when fresh, stale when old or index.stale, offline after errors, missing when absent', () => {
    expect(feedHealth(base).kind).toBe('live');
    expect(feedHealth({ ...base, generatedMs: base.now - 400_000 }).kind).toBe('stale');
    expect(feedHealth({ ...base, indexStale: true }).kind).toBe('stale');
    expect(feedHealth({ ...base, errors: 3 }).kind).toBe('offline');
    expect(feedHealth({ ...base, lastOkAt: null, missing: true }).kind).toBe('missing');
    expect(feedHealth({ ...base, lastOkAt: null }).kind).toBe('connecting');
  });
  it('badge text is honest about delay and age', () => {
    expect(feedBadge({ kind: 'live', ageS: 30 }, 100).text).toBe('LIVE · ≈1.7 min behind');
    expect(feedBadge({ kind: 'stale', ageS: 600 }, 100).text).toBe('STALE · feed 10 min old');
    expect(feedBadge({ kind: 'offline', ageS: null }, 100).text).toMatch(/OFFLINE/);
    expect(feedBadge({ kind: 'demo', ageS: null }, 75).text).toMatch(/simulated/);
  });
});
