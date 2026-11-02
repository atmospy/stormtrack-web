import { loadLightning, loadLightningIndexOnly, type LightningBundle } from '#lib/data/load';
import type { LightningIndex } from '#lib/data/lightning';
import { countBySource, countInWindow, inCoverage } from '#lib/data/lightning';
import { app, type Availability } from '#lib/stores/app.svelte';
import { toast } from '#lib/stores/toast.svelte';
import type { FeedHealth } from './poller';
import type { LightningGLLayer } from './layer';
import type { LiveController } from './live';
import type { ThunderEngine } from './audio';

export const OUTSIDE_NOTICE = 'No real-time lightning feed covers this region yet. We show GOES GLM (the Americas, Atlantic and east Pacific) and IMD (India and nearby seas, about 5 to 35 minutes behind).';
const REFRESH_MS = 60_000;
/** the 2-3 MB flashes.json is only reloaded this often; between those the cheap index.json is enough */
const FULL_RELOAD_MS = 5 * 60_000;
const SOUND_KEY = 'stormtrack.lightning.sound';

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
  private lastFull = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  // ---- live / animated / audible (CONTRACTS 6.2)
  /** simulated feed requested (?lightning=demo or the panel button) */
  demoRequested = $state(typeof location !== 'undefined' && new URLSearchParams(location.search).get('lightning') === 'demo');
  demoActive = $state(false);
  feed = $state<FeedHealth>({ kind: 'connecting', ageS: null });
  feedNote = $state('');
  /** seconds the playback runs behind real time (index.live.delay_s) */
  delayS = $state(90);
  /** user setting "Reduce flashing" (also set by prefers-reduced-motion, see reduceEffective) */
  reduceFlashing = $state(false);
  rates = $state<number[]>([]);
  pending = $state(0);
  concurrent = $state(0);
  played = $state(0);
  nearMinute = $state(0);
  /** screen-reader text, rate-limited by the controller */
  announce = $state('');
  halfWidthKm = $state(3000);
  soundPref = $state(false);
  soundActive = $state(false);
  volume = $state(0.6);
  layer: LightningGLLayer | null = null;
  engine: ThunderEngine | null = null;
  controller: LiveController | null = null;
  private real: LightningBundle | null = null;

  constructor() {
    try {
      const v = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null') as { on?: unknown; volume?: unknown } | null;
      if (v && typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1) this.volume = v.volume;
      if (v && v.on === true) this.soundPref = true; // remembered, but the sound stays off until the next click
    } catch {
      /* storage unavailable: defaults */
    }
  }

  get stale(): boolean {
    return this.bundle?.index.stale === true;
  }
  get reduceEffective(): boolean {
    return this.reduceFlashing || app.reducedMotion;
  }
  /** sources with strikes in view (credit them, and flag unofficial / stale / bucketed ones) */
  get visibleSources() {
    const b = this.bundle;
    if (b?.demo) return b.index.sources.map((s, i) => ({ s, n: this.rates[i] ?? 0 })).filter((x) => x.n > 0);
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

  /** the instant whose strikes are being played now (the layer's animation clock) */
  playbackMs = (): number => this.controller?.playbackMs ?? Date.now() - this.delayS * 1000;

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
    if (box) {
      const lat = (box.north + box.south) / 2;
      const span = box.west <= box.east ? box.east - box.west : box.east - box.west + 360;
      this.halfWidthKm = Math.max(5, (span / 2) * 111.32 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    } else this.halfWidthKm = 8000;
    this.tick();
  }

  updateCentre(lon: number, lat: number): void {
    const c = this.bundle?.coverage;
    this.insideCoverage = c ? inCoverage(c, lon, lat) : null;
  }

  /** Fetch (or re-fetch) the files; keeps the previous data when a refresh fails. After the first load only index.json is re-fetched, except every few minutes. */
  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      const real = this.real ?? (this.bundle && !this.bundle.demo ? this.bundle : null);
      if (real && Date.now() - this.lastFull < FULL_RELOAD_MS) {
        const idx = await loadLightningIndexOnly(real.base);
        if (idx) this.setReal({ ...real, index: idx as LightningIndex });
        return;
      }
      const r = await loadLightning();
      if (r.ok) {
        this.lastFull = Date.now();
        this.loadedAt = Date.now();
        this.availability = 'ready';
        this.setReal(r.value);
      } else if (!real) this.availability = r.missing ? 'missing' : 'error';
    })().finally(() => (this.inflight = null));
    return this.inflight;
  }
  private setReal(b: LightningBundle): void {
    this.real = b;
    if (!this.demoActive) this.bundle = b;
    this.tick();
  }

  setDemoBundle(index: LightningIndex, coverage: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>): void {
    this.bundle = { index, flashes: null, coverage, base: 'demo', sample: false, warnings: [], demo: true };
    this.availability = 'ready';
    this.tick();
  }
  clearDemoBundle(): void {
    this.bundle = this.real;
    if (!this.real) this.availability = 'missing';
    this.tick();
  }

  /** The layer that draws the strikes (created by MapView). */
  attachLayer(l: LightningGLLayer | null): void {
    this.layer = l;
    this.controller?.layerReady();
  }

  /** Switch between the real feed and the simulated one. */
  async setDemo(on: boolean): Promise<void> {
    this.demoRequested = on;
    if (this.controller) await this.controller.start(on ? 'demo' : 'live');
  }

  /**
   * Start / stop the live experience while the layer is on. Returns a stop function.
   * Everything heavy (poller, player, synthesis, GL) is code-split and only loaded here.
   */
  start(): () => void {
    let stopped = false;
    void this.refresh();
    const clock = setInterval(() => this.tick(), 5000);
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, REFRESH_MS);
    void (async () => {
      if (!this.demoRequested) await this.refresh(); // index.live (delay, poll) is needed to start honestly
      if (stopped) return;
      const { LiveController } = await import('./live');
      if (stopped) return;
      const c = new LiveController();
      this.controller = c;
      await c.start(this.demoRequested ? 'demo' : 'live');
      if (stopped) c.stop();
    })();
    return () => {
      stopped = true;
      clearInterval(clock);
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.controller?.stop();
      this.controller = null;
      this.demoActive = false;
      this.soundActive = false; // the context is suspended; a click resumes it
      this.feed = { kind: 'connecting', ageS: null };
    };
  }

  // ---- sound (must be called from a click / key press)
  private save(): void {
    try {
      localStorage.setItem(SOUND_KEY, JSON.stringify({ on: this.soundPref, volume: this.volume }));
    } catch {
      /* private mode: not remembered */
    }
  }
  async setSound(on: boolean): Promise<void> {
    if (on) {
      try {
        const m = await import('./audio');
        this.engine ??= new m.ThunderEngine({ volume: this.volume });
        await this.engine.enable();
        this.soundPref = true;
        this.soundActive = true;
      } catch (e) {
        console.warn('audio unavailable', e);
        toast.show('Sound is not available in this browser', 'warn');
        this.soundActive = false;
      }
    } else {
      this.soundPref = false;
      this.soundActive = false;
      await this.engine?.setActive(false);
    }
    this.save();
  }
  toggleSound(): Promise<void> {
    return this.setSound(!this.soundActive);
  }
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    this.engine?.setVolume(this.volume);
    this.save();
  }
  /** Two sample thunderclaps (one close, one far) so the listener can judge the sound. */
  testSound(): void {
    if (!this.engine || !this.soundActive) return;
    this.engine.strike({ km: 3, energyFj: 400, pan: -0.3 });
    setTimeout(() => this.engine?.strike({ km: 90, energyFj: 400, pan: 0.4 }), 2500);
  }
}

export const lightning = new LightningState();
