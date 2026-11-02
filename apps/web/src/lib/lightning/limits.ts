/**
 * Rate and area limits for the lightning animation. Pure (injectable clock), unit-tested.
 *
 * PHOTOSENSITIVITY BY CONSTRUCTION (WCAG 2.3.1): only small point flashes exist; there is no full-screen or
 * large-area flash at all. A "core" flash is at most CORE_MAX_PX across (<= 154 px^2) and lasts ~120 ms. The
 * FlashBudget caps the summed area of cores that are lit at the same time to AREA_BUDGET_PX2 across the WHOLE
 * screen, which is below 25 % of the 341 x 256 px reference field (87 296 px^2) that the guideline's "general flash"
 * threshold is defined on, whatever part of the screen they are in. So even a burst of thousands of strikes cannot
 * add up to a flash that exceeds the area threshold, and the "no more than three flashes per second" rule is not
 * needed (it only applies to flashes above the threshold). Rings are 1.5 px outlines and never count as flashes.
 */

export const CORE_MIN_PX = 5;
export const CORE_MAX_PX = 14;
export const CORE_LIFE_MS = 120;
export const RING_LIFE_MS = 1500;
/** 20.6 % of the 87 296 px^2 reference field, over the whole screen */
export const AREA_BUDGET_PX2 = 18_000;
export const MAX_CONCURRENT = 300;

/** energy (fJ, null = unknown) -> 0..1 size factor, log scale */
export function energySize(energyFj: number | null | undefined): number {
  if (energyFj === null || energyFj === undefined || !Number.isFinite(energyFj)) return 0.35;
  return Math.min(1, Math.max(0.1, Math.log10(Math.max(1, energyFj)) / 3.2));
}
export const coreDiameterPx = (size: number) => CORE_MIN_PX + (CORE_MAX_PX - CORE_MIN_PX) * Math.min(1, Math.max(0, size));
export const coreAreaPx2 = (size: number) => Math.PI * (coreDiameterPx(size) / 2) ** 2;

export type FlashKind = 'flash' | 'soft' | 'dim';

export interface BudgetOptions {
  maxConcurrent?: number;
  areaBudgetPx2?: number;
  /** strikes in the same screen cell closer in time than this are merged (the later one is dim) */
  mergeMs?: number;
  /** reduced-flashing mode: never a flash/ring, only a gentle fade-in dot, at most this many per second */
  softPerSec?: number;
}

/**
 * Decides, per released strike, whether it gets the full flash+ring (`flash`), a gentle fade-in dot (`soft`, reduce
 * flashing mode) or only the afterglow (`dim`: over budget, merged with a neighbour, or rate-limited).
 * Call with strikes sorted by energy (high first) within a frame so heavy cells keep their strongest flashes.
 */
export class FlashBudget {
  reduced = false;
  private active: { t: number; area: number }[] = [];
  private cells = new Map<number, number>();
  private softWindowStart = 0;
  private softInWindow = 0;
  private readonly maxConcurrent: number;
  private readonly areaBudget: number;
  private readonly mergeMs: number;
  private readonly softPerSec: number;
  stats = { flash: 0, soft: 0, dim: 0, merged: 0 };

  constructor(o: BudgetOptions = {}) {
    this.maxConcurrent = o.maxConcurrent ?? MAX_CONCURRENT;
    this.areaBudget = o.areaBudgetPx2 ?? AREA_BUDGET_PX2;
    this.mergeMs = o.mergeMs ?? 250;
    this.softPerSec = o.softPerSec ?? 40;
  }

  /** summed core area currently lit (px^2), for tests and the HUD */
  litArea(nowMs: number): number {
    let a = 0;
    for (const f of this.active) if (nowMs - f.t < CORE_LIFE_MS) a += f.area;
    return a;
  }
  get concurrent(): number {
    return this.active.length;
  }

  decide(size: number, cell: number, nowMs: number): FlashKind {
    // forget finished animations
    while (this.active.length && nowMs - this.active[0]!.t >= RING_LIFE_MS) this.active.shift();
    if (this.cells.size > 4096) for (const [k, t] of this.cells) if (nowMs - t > this.mergeMs) this.cells.delete(k);
    const last = this.cells.get(cell);
    if (last !== undefined && nowMs - last < this.mergeMs) {
      this.stats.merged++;
      this.stats.dim++;
      return 'dim';
    }
    this.cells.set(cell, nowMs);
    if (this.reduced) {
      if (nowMs - this.softWindowStart >= 1000) {
        this.softWindowStart = nowMs;
        this.softInWindow = 0;
      }
      if (this.softInWindow >= this.softPerSec) {
        this.stats.dim++;
        return 'dim';
      }
      this.softInWindow++;
      this.stats.soft++;
      return 'soft';
    }
    const area = coreAreaPx2(size);
    if (this.active.length >= this.maxConcurrent || this.litArea(nowMs) + area > this.areaBudget) {
      this.stats.dim++;
      return 'dim';
    }
    this.active.push({ t: nowMs, area });
    this.stats.flash++;
    return 'flash';
  }
}

/** Rolling per-source strike counts ("GOES 41 /min"): timestamps in, counts out. */
export class RateCounter {
  private times: number[][];
  private heads: number[];
  constructor(n: number, private readonly windowMs = 60_000) {
    this.times = Array.from({ length: Math.max(1, n) }, () => []);
    this.heads = new Array(Math.max(1, n)).fill(0);
  }
  add(src: number, t: number): void {
    const a = this.times[src] ?? this.times[0]!;
    a.push(t);
  }
  counts(nowMs: number): number[] {
    return this.times.map((a, i) => {
      let h = this.heads[i]!;
      while (h < a.length && a[h]! < nowMs - this.windowMs) h++;
      if (h > 2048) {
        a.splice(0, h);
        h = 0;
      }
      this.heads[i] = h;
      return a.length - h;
    });
  }
  reset(): void {
    this.times.forEach((a) => (a.length = 0));
    this.heads.fill(0);
  }
}

/** Rate-limited screen-reader announcements: at most one per `minGapMs`, and only when the count changed enough. */
export class Announcer {
  private lastAt = -Infinity;
  private lastCount = -1;
  constructor(private readonly minGapMs = 30_000) {}
  /** returns text to announce, or null when it is too soon / nothing notable changed */
  next(nowMs: number, countLastMinute: number, where: string): string | null {
    if (nowMs - this.lastAt < this.minGapMs) return null;
    const changed = this.lastCount < 0 ? countLastMinute > 0 : Math.abs(countLastMinute - this.lastCount) >= Math.max(3, this.lastCount * 0.25);
    if (!changed) return null;
    this.lastAt = nowMs;
    this.lastCount = countLastMinute;
    return countLastMinute === 0 ? `No lightning strikes in the last minute ${where}` : `${countLastMinute} lightning ${countLastMinute === 1 ? 'strike' : 'strikes'} in the last minute ${where}`;
  }
}
