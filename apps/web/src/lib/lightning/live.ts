import { DATA_BASE } from '#lib/config';
import { app } from '#lib/stores/app.svelte';
import { meteo } from '#lib/weather/meteo.svelte';
import type { Flashes, Strike } from '#lib/data/lightning';
import { lightning } from './state.svelte';
import { LightningPlayer } from './player';
import { RecentPoller, feedHealth, type FeedHealth } from './poller';
import { demoCoverage, demoFlashes, demoIndex, demoRecent, DEMO_DELAY_S } from './demo';
import { Announcer, FlashBudget, RateCounter, energySize } from './limits';
import { MODE_DIM, MODE_FLASH, MODE_SOFT } from './layer';
import { AUDIBLE_KM, eastOffsetKm, haversineKm, panFromOffset } from './audio';

/** a strike released later than this after its time is drawn as afterglow only and makes no sound (a stall, a cold start, a lump) */
const LATE_MS = 2500;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** recent.json-shaped JSON for the demo: it goes through the real fetch -> parse -> player pipeline */
function demoResponse(nowMs: number): Response {
  const r = demoRecent(nowMs);
  const body = { schema: 1, generated: r.generated, window_s: r.window_s, cols: ['id', 't_ms', 'lon', 'lat', 'energy_fj', 'src'], rows: r.strikes.map((s) => [s.id, s.t_ms, s.lon, s.lat, s.energy_fj, s.src]) };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Runs the live lightning experience while the layer is on: poller -> player (fixed delay behind real time) ->
 * GL layer + synthesised sound, plus the honest status the UI shows. Lazy-loaded; owns every timer it creates.
 */
export class LiveController {
  player!: LightningPlayer;
  private poller: RecentPoller | null = null;
  private budget = new FlashBudget();
  private rates = new RateCounter(4);
  private near = new RateCounter(1);
  private announcer = new Announcer(30_000);
  private raf = 0;
  private statTimer: ReturnType<typeof setInterval> | null = null;
  private batch: { s: Strike; late: number }[] = [];
  private mode: 'live' | 'demo' = 'live';
  private pollMs = 15_000;
  private backlogDone = false;
  private firstSettled = false;
  private oldestRecent = Infinity;
  private running = false;
  private lastKm = new Map<string, number>();

  async start(mode: 'live' | 'demo'): Promise<void> {
    this.stop();
    this.mode = mode;
    this.running = true;
    this.backlogDone = false;
    this.firstSettled = false;
    this.oldestRecent = Infinity;
    this.rates.reset();
    this.near.reset();
    lightning.layer?.clear();

    const index = mode === 'demo' ? demoIndex(Date.now()) : lightning.bundle?.index ?? null;
    const delayMs = (index?.live?.delay_s ?? (mode === 'demo' ? DEMO_DELAY_S : 90)) * 1000;
    this.pollMs = clamp((index?.live?.poll_s ?? 20) * 1000, 10_000, 15_000);
    lightning.delayS = delayMs / 1000;
    lightning.demoActive = mode === 'demo';

    this.player = new LightningPlayer({ delayMs, maxLateMs: 10 * 60_000, onStrike: (s, late) => this.batch.push({ s, late }) });
    this.poller = new RecentPoller({
      url: `${DATA_BASE}/lightning/recent.json`,
      pollMs: this.pollMs,
      fetchFn: mode === 'demo' ? (async () => demoResponse(Date.now())) as typeof fetch : undefined,
      isHidden: () => document.hidden,
      onRecent: (r, info) => {
        if (info.notModified) return;
        for (const s of r.strikes) if (s.t_ms < this.oldestRecent) this.oldestRecent = s.t_ms;
        this.player.push(r.strikes);
        this.settle();
      },
      onError: (e) => {
        if (e.missing) lightning.feedNote = 'recent.json is not published here';
        else lightning.feedNote = e.message;
        this.settle();
      }
    });
    if (mode === 'demo') lightning.setDemoBundle(demoIndex(Date.now()), demoCoverage());
    else lightning.clearDemoBundle();
    this.poller.start();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.raf = requestAnimationFrame(this.frame);
    this.statTimer = setInterval(() => this.stats(), 1000);
    this.stats();
    if (lightning.engine && lightning.soundPref) void lightning.engine.setActive(!document.hidden);
    lightning.layer?.setVisible(true);
  }

  stop(): void {
    this.running = false;
    this.poller?.stop();
    this.poller = null;
    cancelAnimationFrame(this.raf);
    if (this.statTimer) clearInterval(this.statTimer);
    this.statTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    lightning.layer?.setVisible(false);
    void lightning.engine?.setActive(false); // no CPU when silent
  }

  /** the playback instant (unix ms): strikes at this time are being played now */
  get playbackMs(): number {
    return this.player ? this.player.playbackTime : Date.now();
  }

  /** the layer was (re)attached: draw the backlog again if it was waiting */
  layerReady(): void {
    this.backlogDone = false;
    if (this.firstSettled) this.applyBacklog();
  }

  private settle(): void {
    this.firstSettled = true;
    this.applyBacklog();
  }

  /** 60 minutes of history as faint afterglow, up to where the live feed takes over (never duplicated) */
  private applyBacklog(): void {
    const layer = lightning.layer;
    if (this.backlogDone || !layer || !this.running) return;
    this.backlogDone = true;
    const pb = this.playbackMs;
    const until = Math.min(this.oldestRecent, pb) - 1;
    let f: Flashes | null;
    let shift = 0;
    if (this.mode === 'demo') f = demoFlashes(Date.now(), until);
    else {
      const b = lightning.bundle;
      f = b?.flashes ?? null;
      if (b?.sample) shift = pb - Date.parse(b.index.updated); // bundled sample: replay its own timeline as if it just ended
    }
    if (!f || f.n === 0) return;
    const from = Math.max(0, f.n - layer.capacity + 2000); // keep room for live strikes
    for (let i = from; i < f.n; i++) {
      const t = f.t0 + f.dt[i]! * 1000 + shift;
      if (t > until) break;
      layer.add(f.lon[i]!, f.lat[i]!, t, energySize(f.energy[i]! > 0 ? f.energy[i]! : null), MODE_DIM);
    }
    layer.flush();
  }

  private frame = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    this.batch.length = 0;
    if (this.player.tick() === 0) return;
    this.process();
  };

  private listener(): { lon: number; lat: number; pinned: boolean } {
    const p = meteo.point;
    return p ? { lon: p.lon, lat: p.lat, pinned: true } : { lon: app.center.lon, lat: app.center.lat, pinned: false };
  }

  private process(): void {
    const layer = lightning.layer;
    const b = this.batch;
    // strongest first, so a crowded cell keeps its best flashes when the budget runs out
    b.sort((x, y) => (y.s.energy_fj ?? 0) - (x.s.energy_fj ?? 0));
    const reduce = lightning.reduceEffective;
    this.budget.reduced = reduce;
    const now = performance.now();
    const cellDeg = 360 / (512 * 2 ** Math.max(0, app.zoom)) * 1.5; // ~1.5 px
    const L = this.listener();
    const engine = lightning.engine;
    const soundOn = lightning.soundActive && engine !== null;
    const halfW = lightning.halfWidthKm;
    for (const { s, late } of b) {
      const km = haversineKm(L.lat, L.lon, s.lat, s.lon);
      const size = energySize(s.energy_fj);
      if (late > LATE_MS) {
        layer?.add(s.lon, s.lat, s.t_ms, size, MODE_DIM); // caught-up strikes: afterglow only, not counted as live rate, no sound
        continue;
      }
      this.rates.add(s.src, Date.now());
      if (km <= 300) this.near.add(0, Date.now());
      const kind = this.budget.decide(size, Math.floor(s.lon / cellDeg) * 100003 + Math.floor(s.lat / cellDeg), now);
      layer?.add(s.lon, s.lat, s.t_ms, size, kind === 'flash' ? MODE_FLASH : kind === 'soft' ? MODE_SOFT : MODE_DIM);
      if (soundOn && km <= AUDIBLE_KM) engine.strike({ km, energyFj: s.energy_fj, pan: panFromOffset(eastOffsetKm(L.lat, L.lon, s.lat, s.lon), halfW) });
    }
    layer?.flush();
    lightning.played += b.length;
  }

  private health(): FeedHealth {
    if (this.mode === 'demo') return { kind: 'demo', ageS: null };
    const p = this.poller;
    return feedHealth({
      now: Date.now(),
      generatedMs: p?.lastGenerated ?? null,
      indexStale: lightning.stale,
      lastOkAt: p?.lastOkAt ?? null,
      errors: p?.errors ?? 0,
      missing: p?.missing ?? false,
      pollMs: this.pollMs
    });
  }

  private stats(): void {
    if (!this.running) return;
    const now = Date.now();
    lightning.rates = this.rates.counts(now);
    lightning.feed = this.health();
    lightning.pending = this.player.pending;
    lightning.concurrent = this.budget.concurrent;
    lightning.nearMinute = this.near.counts(now)[0] ?? 0;
    const where = this.listener().pinned ? 'near the pinned place' : 'near the map centre';
    const text = this.announcer.next(now, lightning.nearMinute, where);
    if (text) lightning.announce = text;
    void this.lastKm;
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      void lightning.engine?.setActive(false);
    } else {
      this.poller?.resume();
      if (lightning.soundActive) void lightning.engine?.setActive(true);
    }
  };
}
