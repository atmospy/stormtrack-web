import { describe, expect, it } from 'vitest';
import { LoginGate, type GateConfig } from './gate';

const cfg: GateConfig = { activeMs: 180_000, interactions: 8, snoozeMs: 24 * 3600_000, storageKey: 'k' };
function setup() {
  let t = 1_000_000;
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const gate = new LoginGate(cfg, { now: () => t, storage });
  return { gate, advance: (ms: number) => { t += ms; gate.tick(); }, store, setNow: (v: number) => (t = v), now: () => t };
}

describe('LoginGate', () => {
  it('does not show before thresholds', () => {
    const { gate, advance } = setup();
    advance(179_000);
    for (let i = 0; i < 7; i++) gate.interact();
    expect(gate.shouldShow).toBe(false);
  });
  it('shows after 3 minutes of active time', () => {
    const { gate, advance } = setup();
    advance(180_000);
    expect(gate.shouldShow).toBe(true);
  });
  it('shows after 8 interactions', () => {
    const { gate } = setup();
    for (let i = 0; i < 8; i++) gate.interact();
    expect(gate.shouldShow).toBe(true);
  });
  it('pauses the timer while the tab is hidden', () => {
    const { gate, advance } = setup();
    advance(100_000);
    gate.setVisible(false);
    advance(600_000);
    expect(gate.shouldShow).toBe(false);
    gate.setVisible(true);
    advance(79_000);
    expect(gate.shouldShow).toBe(false);
    advance(1_500);
    expect(gate.shouldShow).toBe(true);
    expect(gate.stats.activeMs).toBeCloseTo(180_500, -2);
  });
  it('"Not now" snoozes for 24 h, then can show again', () => {
    const { gate, advance, store, setNow, now } = setup();
    advance(180_000);
    expect(gate.shouldShow).toBe(true);
    gate.dismiss();
    expect(gate.shouldShow).toBe(false);
    expect(Number(store.get('k'))).toBe(now() + cfg.snoozeMs);
    advance(500_000);
    for (let i = 0; i < 20; i++) gate.interact();
    expect(gate.shouldShow).toBe(false);
    // a fresh page load after the snooze elapsed
    const t = now() + cfg.snoozeMs + 1;
    const g2 = new LoginGate(cfg, { now: () => t, storage: { getItem: (k) => store.get(k) ?? null, setItem: () => {} } });
    for (let i = 0; i < 8; i++) g2.interact();
    expect(g2.shouldShow).toBe(true);
    setNow(t);
  });
  it('a fresh page load inside the snooze window stays hidden', () => {
    const { gate, advance, store, now } = setup();
    advance(180_000);
    gate.dismiss();
    const g2 = new LoginGate(cfg, { now: () => now() + 1000, storage: { getItem: (k) => store.get(k) ?? null, setItem: () => {} } });
    for (let i = 0; i < 20; i++) g2.interact();
    expect(g2.shouldShow).toBe(false);
  });
  it('never shows to signed-in users', () => {
    const { gate, advance } = setup();
    gate.setSuppressed(true);
    advance(500_000);
    expect(gate.shouldShow).toBe(false);
  });
  it('stays shown until dismissed', () => {
    const { gate, advance } = setup();
    advance(180_000);
    advance(10_000);
    expect(gate.shouldShow).toBe(true);
  });
});
