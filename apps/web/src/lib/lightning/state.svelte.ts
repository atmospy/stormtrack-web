import { loadLightning, type LightningBundle } from '#lib/data/load';
import { countBySource, countInWindow, inCoverage } from '#lib/data/lightning';
import type { Availability } from '#lib/stores/app.svelte';

export const OUTSIDE_NOTICE = 'No open real-time lightning feed covers this region yet. GOES GLM covers the Americas, Atlantic and east Pacific.';
const REFRESH_MS = 60_000;

class LightningState {
  bundle = $state.raw<LightningBundle | null>(null);
  availability = $state<Availability>('loading');
  window = $state<5 | 15 | 60>(15);
  /** "now" on the data clock: wall clock for live data; for bundled SAMPLE data, the sample's own timeline advanced in real time */
  nowMs = $state(Date.now());
  /** flashes in the last 10 minutes (the headline number) */
  count10 = $state(0);
  countWindow = $state(0);
  insideCoverage = $state<boolean | null>(null);
  /** strikes per source (index.sources order) inside the current view and window */
  inView = $state<number[]>([]);
  box: { west: number; south: number; east: number; north: number } | null = null;
  loadedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  get stale(): boolean {
    return this.bundle?.index.stale === true;
  }
  /** sources with strikes in view (credit them, and flag unofficial / stale / bucketed ones) */
  get visibleSources() {
    const b = this.bundle;
    return b ? b.index.sources.map((s, i) => ({ s, n: this.inView[i] ?? 0 })).filter((x) => x.n > 0) : [];
  }
  /** minutes since the producer's `updated` stamp */
  get ageMin(): number | null {
    const b = this.bundle;
    return b ? Math.max(0, Math.round((this.nowMs - Date.parse(b.index.updated)) / 60000)) : null;
  }

  private clock(): number {
    const b = this.bundle;
    if (!b) return Date.now();
    return b.sample ? Date.parse(b.index.updated) + (Date.now() - this.loadedAt) : Date.now();
  }

  tick(): void {
    this.nowMs = this.clock();
    const f = this.bundle?.flashes;
    if (f) {
      this.count10 = countInWindow(f, this.nowMs, 10 * 60_000);
      this.countWindow = countInWindow(f, this.nowMs, this.window * 60_000);
      this.inView = countBySource(f, this.nowMs, this.window * 60_000, this.box, this.bundle!.index.sources.length);
    } else {
      this.count10 = 0;
      this.countWindow = 0;
    }
  }

  setView(box: { west: number; south: number; east: number; north: number } | null): void {
    this.box = box;
    this.tick();
  }

  updateCentre(lon: number, lat: number): void {
    const c = this.bundle?.coverage;
    this.insideCoverage = c ? inCoverage(c, lon, lat) : null;
  }

  /** Fetch (or re-fetch) the three files; keeps the previous data when a refresh fails. */
  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      const r = await loadLightning();
      if (r.ok) {
        this.bundle = r.value;
        this.loadedAt = Date.now();
        this.availability = 'ready';
        this.tick();
      } else if (!this.bundle) this.availability = r.missing ? 'missing' : 'error';
    })().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** Start the 60 s refresh + 1 s clock while the layer is on. Returns a stop function. */
  start(): () => void {
    void this.refresh();
    const clock = setInterval(() => this.tick(), 5000);
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, REFRESH_MS);
    return () => {
      clearInterval(clock);
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }
}

export const lightning = new LightningState();
