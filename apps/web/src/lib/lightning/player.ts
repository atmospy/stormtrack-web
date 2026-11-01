import type { Strike } from '#lib/data/lightning';

export interface PlayerOptions {
  /** how far behind real time strikes are played (index.live.delay_s * 1000) */
  delayMs: number;
  /** injectable clock (ms); defaults to Date.now so tests and replays can drive time */
  now?: () => number;
  /** called once per strike when playback time reaches its timestamp; `lateMs` is how overdue it is */
  onStrike: (s: Strike, lateMs: number) => void;
  /** strikes more than this far in the past of playback time when they arrive are dropped, not played (default 30 s) */
  maxLateMs?: number;
  /** remember ids this long for de-duplication across polls (default 10 min) */
  idTtlMs?: number;
}

/**
 * Playback queue for the live lightning experience (CONTRACTS 6.2). Polls push batches (overlapping, possibly out
 * of order); the player de-duplicates by `id` and releases each strike when playback time (clock - delay) reaches
 * its `t_ms`, in time order. It owns no timers: call `tick()` from requestAnimationFrame (or from a test).
 */
export class LightningPlayer {
  private queue: Strike[] = []; // sorted by t_ms ascending
  private seen = new Map<string, number>(); // id -> t_ms
  private readonly now: () => number;
  readonly delayMs: number;
  private readonly maxLateMs: number;
  private readonly idTtlMs: number;
  private readonly onStrike: PlayerOptions['onStrike'];
  /** counters for the UI / tests */
  stats = { received: 0, duplicates: 0, dropped: 0, played: 0 };

  constructor(o: PlayerOptions) {
    this.now = o.now ?? Date.now;
    this.delayMs = o.delayMs;
    this.maxLateMs = o.maxLateMs ?? 30_000;
    this.idTtlMs = o.idTtlMs ?? 600_000;
    this.onStrike = o.onStrike;
  }

  /** the instant (unix ms) whose strikes are being played right now */
  get playbackTime(): number {
    return this.now() - this.delayMs;
  }
  get pending(): number {
    return this.queue.length;
  }

  /** Add a polled batch. Returns how many were new and queued. */
  push(batch: readonly Strike[]): number {
    const pb = this.playbackTime;
    let added = 0;
    for (const s of batch) {
      this.stats.received++;
      if (this.seen.has(s.id)) {
        this.stats.duplicates++;
        continue;
      }
      this.seen.set(s.id, s.t_ms);
      if (s.t_ms < pb - this.maxLateMs) {
        this.stats.dropped++;
        continue;
      }
      let lo = 0, hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.queue[mid]!.t_ms <= s.t_ms) lo = mid + 1;
        else hi = mid;
      }
      this.queue.splice(lo, 0, s);
      added++;
    }
    this.prune();
    return added;
  }

  /** Release every strike whose time has come. Returns how many were released. */
  tick(): number {
    const pb = this.playbackTime;
    let n = 0;
    while (this.queue.length && this.queue[0]!.t_ms <= pb) {
      const s = this.queue.shift()!;
      this.stats.played++;
      n++;
      this.onStrike(s, pb - s.t_ms);
    }
    return n;
  }

  /** Forget everything (e.g. when the layer is switched off). */
  reset(): void {
    this.queue = [];
    this.seen.clear();
  }

  private prune(): void {
    const cut = this.now() - this.idTtlMs;
    for (const [id, t] of this.seen) if (t < cut) this.seen.delete(id);
  }
}
