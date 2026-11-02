import { parseRecent, type Recent } from '#lib/data/lightning';

/** What the user is told about the feed. Never better than the truth. */
export type FeedKind = 'connecting' | 'live' | 'stale' | 'offline' | 'missing' | 'demo' | 'replay';
export interface FeedHealth {
  kind: FeedKind;
  /** age of the newest published file (s), null when unknown */
  ageS: number | null;
}

export const STALE_AFTER_S = 150;

/**
 * Pure health rules. `generatedMs`: the `generated` stamp of the last good recent.json; `lastOkAt`: when we last
 * fetched one; `errors`: consecutive failures; `missing`: the file does not exist (404 / HTML fallback).
 */
export function feedHealth(i: { now: number; generatedMs: number | null; indexStale: boolean; lastOkAt: number | null; errors: number; missing: boolean; pollMs: number }): FeedHealth {
  const ageS = i.generatedMs === null ? null : Math.max(0, Math.round((i.now - i.generatedMs) / 1000));
  if (i.missing && i.lastOkAt === null) return { kind: 'missing', ageS };
  if (i.lastOkAt === null) return { kind: i.errors >= 3 ? 'offline' : 'connecting', ageS };
  if (i.errors >= 3 || i.now - i.lastOkAt > Math.max(60_000, i.pollMs * 4)) return { kind: 'offline', ageS };
  if (i.indexStale || (ageS !== null && ageS > STALE_AFTER_S)) return { kind: 'stale', ageS };
  return { kind: 'live', ageS };
}

export interface PollerOptions {
  url: string;
  /** poll interval in ms (index.live.poll_s, clamped to 10-15 s by the caller) */
  pollMs: number;
  onRecent: (r: Recent, info: { notModified: boolean }) => void;
  onError?: (e: { message: string; missing: boolean; errors: number }) => void;
  isHidden?: () => boolean;
  fetchFn?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** jitter source, 0..1 (injectable for tests) */
  rand?: () => number;
  maxBackoffMs?: number;
}

/**
 * Polls recent.json. Rules: one request at a time (never stacks); the browser revalidates with ETag
 * (`cache: 'no-cache'`), a 304 is cheap and fine; paused while the tab is hidden (resume() polls at once);
 * failures back off exponentially (poll x 2^n, capped), success resets; a missing file backs off to a minute.
 */
export class RecentPoller {
  errors = 0;
  missing = false;
  lastOkAt: number | null = null;
  lastGenerated: number | null = null;
  inflight = false;
  requests = 0;
  private timer: unknown = null;
  private running = false;
  private ac: AbortController | null = null;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private readonly rand: () => number;

  constructor(private readonly o: PollerOptions) {
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetchFn ?? ((...a) => fetch(...a));
    this.setT = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.rand = o.rand ?? Math.random;
  }

  /** delay until the next poll given the current failure state */
  nextDelayMs(): number {
    const cap = this.o.maxBackoffMs ?? 120_000;
    if (this.missing) return Math.max(cap / 2, 60_000);
    const base = this.o.pollMs * 2 ** Math.min(this.errors, 6);
    const jitter = 1 + (this.rand() - 0.5) * 0.2; // +-10 %
    return Math.min(cap, base) * (this.errors ? 1 : jitter);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }
  stop(): void {
    this.running = false;
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
    this.ac?.abort();
    this.ac = null;
  }
  /** tab became visible again: poll right away (unless one is in flight) */
  resume(): void {
    if (!this.running) return;
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
    if (!this.inflight) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = this.setT(() => {
      this.timer = null;
      void this.poll();
    }, ms);
  }

  async poll(): Promise<void> {
    if (!this.running || this.inflight) return;
    if (this.o.isHidden?.()) {
      // paused: nothing is fetched while hidden; resume() restarts. Re-check slowly in case no event arrives.
      this.schedule(this.o.pollMs);
      return;
    }
    this.inflight = true;
    this.requests++;
    this.ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    try {
      const res = await this.fetchFn(this.o.url, { cache: 'no-cache', signal: this.ac?.signal });
      if (res.status === 304) {
        this.ok(null);
        return;
      }
      const ct = res.headers.get('content-type') ?? '';
      if (res.status === 404 || ct.includes('text/html')) {
        this.missing = true;
        this.errors++;
        this.o.onError?.({ message: 'recent.json not published', missing: true, errors: this.errors });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.ok(parseRecent(await res.json()));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      this.errors++;
      this.o.onError?.({ message: (e as Error).message, missing: false, errors: this.errors });
    } finally {
      this.inflight = false;
      this.ac = null;
      if (this.running) this.schedule(this.nextDelayMs());
    }
  }

  private ok(r: Recent | null): void {
    this.errors = 0;
    this.missing = false;
    this.lastOkAt = this.now();
    if (r) {
      this.lastGenerated = Date.parse(r.generated);
      this.o.onRecent(r, { notModified: false });
    } else this.o.onRecent({ generated: new Date(this.lastGenerated ?? this.now()).toISOString(), window_s: 0, strikes: [] }, { notModified: true });
  }
}
