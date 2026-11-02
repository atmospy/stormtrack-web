/**
 * Synthesised thunder for the live lightning layer (CONTRACTS 6.2). No audio files: every sound is noise shaped
 * with filters and envelopes. The parameter mapping (distance, energy, priority) is PURE and unit-tested; the
 * synthesis (`renderThunder`) works on any BaseAudioContext, so it can be rendered offline and measured.
 *
 *   near strike  : loud, bright, a sharp crack (high-passed noise burst, ~100 ms) over a short rumble
 *   far strike   : quiet, dull (low-passed), a slow-attack rolling rumble (several randomised sub-bursts), up to ~6 s late
 *
 * Nothing here touches browser globals at import time, so it is safe in node (tests) and lazy-loaded in the app.
 */

// ---------------------------------------------------------------- pure mapping

export const EARTH_KM = 6371.0088;
/** beyond this distance a strike makes no sound at all */
export const AUDIBLE_KM = 500;
/** stylised speed of sound: 1 s per 10 km, capped */
export const KM_PER_SECOND = 10;
export const MAX_DELAY_S = 6;
/** gain used when the source reports no energy (IITM) */
export const DEFAULT_ENERGY_GAIN = 0.55;

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Loudness from distance: 1 at the listener, ~0.5 at 15 km, ~0.15 at 100 km, a faint floor to 500 km, 0 beyond. Monotone decreasing. */
export function distanceToGain(km: number): number {
  if (!(km >= 0) || km > AUDIBLE_KM) return 0;
  const g = 1 / (1 + (km / 15) ** 1.25);
  // taper to exactly 0 at the audible limit so there is no step
  return g * (1 - smooth(AUDIBLE_KM * 0.7, AUDIBLE_KM, km));
}

/** Low-pass cutoff (Hz): 9 kHz at the listener, ~1.5 kHz at 40 km, ~350 Hz at 400 km. Monotone decreasing. */
export function distanceToCutoff(km: number): number {
  const t = 1 / (1 + Math.max(0, km) / 40);
  return 250 * 36 ** t;
}

/** Arrival delay in seconds: 1 s per 10 km, capped at 6 s. */
export function distanceToDelay(km: number): number {
  return clamp(Math.max(0, km) / KM_PER_SECOND, 0, MAX_DELAY_S);
}

/** Share of the sharp crack and of the low rumble in the mix. Near = crack-dominated, far = pure rumble. */
export function distanceToMix(km: number): { crack: number; rumble: number } {
  const d = Math.max(0, km);
  return { crack: 1 - smooth(3, 45, d), rumble: 0.35 + 0.65 * smooth(2, 60, d) };
}

/** Duration (s) of the rolling rumble: short close by, up to ~4.5 s far away. */
export function distanceToRumbleDur(km: number): number {
  return 1.1 + 3.4 * (1 - Math.exp(-Math.max(0, km) / 40));
}

/** Loudness from flash energy (fJ): null/unknown gets a default; log scale from 0.35 (1 fJ) to 1 (about 3 000 fJ). */
export function energyToGain(energyFj: number | null | undefined): number {
  if (energyFj === null || energyFj === undefined || !Number.isFinite(energyFj)) return DEFAULT_ENERGY_GAIN;
  return clamp(0.35 + (0.65 * Math.log10(Math.max(1, energyFj))) / 3.5, 0.35, 1);
}

/** Stereo pan from the strike's east-west offset to the listener, relative to half the visible width. -0.8 .. 0.8. */
export function panFromOffset(dxKm: number, halfWidthKm: number): number {
  if (!(halfWidthKm > 0) || !Number.isFinite(dxKm)) return 0;
  return clamp(dxKm / halfWidthKm, -1, 1) * 0.8;
}

/** east-west offset (km) of a strike from the listener, wrapping across the antimeridian */
export function eastOffsetKm(listenLat: number, listenLon: number, lat: number, lon: number): number {
  let dLon = lon - listenLon;
  dLon = ((((dLon + 180) % 360) + 360) % 360) - 180;
  return ((dLon * Math.PI) / 180) * EARTH_KM * Math.cos(((lat + listenLat) / 2) * (Math.PI / 180));
}

/** slider 0..1 -> master gain (squared: perceptually even) */
export function volumeToGain(v: number): number {
  const x = clamp(Number.isFinite(v) ? v : 0, 0, 1);
  return x * x;
}

export interface ThunderParams {
  /** peak loudness 0..1 (distance x energy) */
  gain: number;
  cutoff: number;
  /** seconds until the sound starts */
  delay: number;
  crack: number;
  rumble: number;
  rumbleDur: number;
  pan: number;
  km: number;
}

export function thunderParams(km: number, energyFj: number | null | undefined, pan = 0): ThunderParams {
  const mix = distanceToMix(km);
  return {
    gain: distanceToGain(km) * energyToGain(energyFj),
    cutoff: distanceToCutoff(km),
    delay: distanceToDelay(km),
    crack: mix.crack,
    rumble: mix.rumble,
    rumbleDur: distanceToRumbleDur(km),
    pan: clamp(pan, -1, 1),
    km
  };
}

/** Priority of a candidate strike: the loudest (nearest, most energetic) first. */
export const voiceScore = (p: Pick<ThunderParams, 'gain'>): number => p.gain;

/**
 * Pick which candidates may sound this burst: highest score first, at most `budget`; silent ones never.
 * Returns indexes into `scores`, best first. Pure and stable for equal scores (earlier first).
 */
export function selectForBurst(scores: readonly number[], budget: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < scores.length; i++) if (scores[i]! > 0.002) idx.push(i);
  idx.sort((a, b) => scores[b]! - scores[a]! || a - b);
  return idx.slice(0, Math.max(0, Math.floor(budget)));
}

/**
 * Voice stealing: with `voices` playing (by score) and a new candidate of score `s`, which voice (index) should be
 * dropped to make room, or -1 when the candidate itself is the quietest and should not play. `max` is the voice limit.
 */
export function voiceToSteal(voices: readonly number[], s: number, max: number): number {
  if (voices.length < max) return -2; // room: nothing to steal
  let q = 0;
  for (let i = 1; i < voices.length; i++) if (voices[i]! < voices[q]!) q = i;
  return voices[q]! < s ? q : -1;
}

/** Token bucket (refills continuously); used to cap how many strikes per second may make sound. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly perSec: number, private readonly burst: number, private readonly now: () => number = () => Date.now()) {
    this.tokens = burst;
    this.last = now();
  }
  /** tokens currently available (whole number) */
  available(): number {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSec);
    this.last = t;
    return Math.floor(this.tokens);
  }
  take(n: number): void {
    this.tokens = Math.max(0, this.tokens - n);
  }
}

// ---------------------------------------------------------------- synthesis

/** A deterministic small PRNG (mulberry32) so a render can be repeated exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeNoise(ctx: BaseAudioContext, seconds: number, rand: () => number): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = rand() * 2 - 1;
  return buf;
}

/** Master chain: bus -> compressor -> tanh limiter -> volume. Nothing leaving it can exceed +/-1. */
export function buildMasterChain(ctx: BaseAudioContext, volume: number): { input: GainNode; master: GainNode } {
  const input = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 12;
  comp.ratio.value = 8;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 2.2) / Math.tanh(2.2) * 0.97;
  shaper.curve = curve;
  shaper.oversample = '2x';
  const master = ctx.createGain();
  master.gain.value = volumeToGain(volume);
  input.connect(comp);
  comp.connect(shaper);
  shaper.connect(master);
  master.connect(ctx.destination);
  return { input, master };
}

export interface Rendered {
  /** context time at which the sound has fully ended */
  end: number;
  /** context time at which it starts */
  start: number;
  /** per-voice gain, ramp it to 0 to steal the voice */
  gain: GainNode;
  stop(): void;
}

/**
 * Schedule one thunder event on `ctx`, starting at `ctx.currentTime + p.delay` (or `at` when given).
 * Crack = high-passed noise burst with a fast exponential decay (plus a faint second crackle).
 * Rumble = low-passed noise, several randomised sub-bursts with slow attack / long exponential decay.
 */
export function renderThunder(ctx: BaseAudioContext, dest: AudioNode, p: ThunderParams, noise: AudioBuffer, rand: () => number, at?: number): Rendered {
  const t0 = at ?? ctx.currentTime + p.delay;
  const voice = ctx.createGain();
  voice.gain.value = 1;
  let out: AudioNode = voice;
  if (typeof ctx.createStereoPanner === 'function') {
    const pan = ctx.createStereoPanner();
    pan.pan.value = p.pan;
    voice.connect(pan);
    out = pan;
  }
  out.connect(dest);
  const sources: AudioBufferSourceNode[] = [];
  let end = t0;
  const play = (filters: AudioNode[], offset: number, start: number, dur: number, env: (g: AudioParam) => void) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0;
    let node: AudioNode = src;
    for (const f of filters) {
      node.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(voice);
    env(g.gain);
    src.start(start, offset % noise.duration);
    src.stop(start + dur);
    sources.push(src);
    end = Math.max(end, start + dur);
  };
  const lp = (f: number, q = 0.7) => {
    const n = ctx.createBiquadFilter();
    n.type = 'lowpass';
    n.frequency.value = clamp(f, 40, ctx.sampleRate * 0.45);
    n.Q.value = q;
    return n;
  };
  const hp = (f: number) => {
    const n = ctx.createBiquadFilter();
    n.type = 'highpass';
    n.frequency.value = f;
    n.Q.value = 0.7;
    return n;
  };

  // (a) crack: only audible when there is a crack share
  const crackAmp = p.gain * p.crack * 0.9;
  if (crackAmp > 0.003) {
    const dur = 0.14 + 0.1 * p.crack;
    play([hp(1100 + 600 * p.crack), lp(p.cutoff)], rand() * noise.duration, t0, dur, (g) => {
      g.setValueAtTime(0, t0);
      g.linearRampToValueAtTime(crackAmp, t0 + 0.002);
      g.exponentialRampToValueAtTime(0.0001, t0 + dur - 0.01);
    });
    // a faint second crackle a few tens of ms later
    const t1 = t0 + 0.02 + rand() * 0.05;
    play([hp(900), lp(p.cutoff * 0.8)], rand() * noise.duration, t1, 0.12, (g) => {
      g.setValueAtTime(0, t1);
      g.linearRampToValueAtTime(crackAmp * 0.35, t1 + 0.003);
      g.exponentialRampToValueAtTime(0.0001, t1 + 0.11);
    });
  }

  // (b) rumble: rolling sub-bursts. Far = slower attack, longer.
  const rumbleAmp = p.gain * p.rumble * 3.2; // low-passed noise is weak; makeup gain (the master limiter keeps it safe)
  if (rumbleAmp > 0.004) {
    const far = clamp(p.km / 120, 0, 1);
    const n = 3 + Math.floor(rand() * 4); // 3..6 sub-bursts
    for (let i = 0; i < n; i++) {
      const off = i === 0 ? 0.03 : rand() * p.rumbleDur * 0.55;
      const start = t0 + off;
      const attack = 0.03 + far * 0.3 + rand() * 0.12;
      const dec = p.rumbleDur * (0.35 + 0.4 * rand());
      const amp = rumbleAmp * (i === 0 ? 1 : 0.35 + 0.5 * rand()) * (1 - 0.45 * (off / p.rumbleDur));
      const cut = clamp(p.cutoff * 0.55, 110, 520) * (0.8 + 0.4 * rand());
      const dur = attack + dec;
      play([lp(cut, 0.9), lp(cut * 1.6)], rand() * noise.duration, start, dur + 0.05, (g) => {
        g.setValueAtTime(0.0001, start);
        g.linearRampToValueAtTime(amp, start + attack);
        g.exponentialRampToValueAtTime(0.0001, start + dur);
      });
    }
  }

  return {
    start: t0,
    end,
    gain: voice,
    stop() {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
      try {
        out.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  };
}

// ---------------------------------------------------------------- engine

export interface EngineOptions {
  maxVoices?: number;
  maxPerSec?: number;
  volume?: number;
  /** override for tests / alternate contexts */
  createContext?: () => AudioContext;
  rand?: () => number;
  now?: () => number;
}
export interface StrikeSound {
  km: number;
  energyFj: number | null;
  pan: number;
}
interface Voice {
  r: Rendered;
  score: number;
}

/** Owns the AudioContext lifecycle, the voice limit and the strikes-per-second cap. */
export class ThunderEngine {
  private ctx: AudioContext | null = null;
  private chain: { input: GainNode; master: GainNode } | null = null;
  private noise: AudioBuffer | null = null;
  private voices: Voice[] = [];
  private pending: ThunderParams[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private volume: number;
  private active = false;
  private readonly maxVoices: number;
  private readonly bucket: TokenBucket;
  private readonly rand: () => number;
  stats = { played: 0, dropped: 0, stolen: 0 };

  constructor(private readonly o: EngineOptions = {}) {
    this.maxVoices = o.maxVoices ?? 24;
    this.volume = o.volume ?? 0.6;
    this.rand = o.rand ?? Math.random;
    const perSec = o.maxPerSec ?? 6;
    this.bucket = new TokenBucket(perSec, Math.max(2, Math.ceil(perSec / 2)), o.now);
  }

  get state(): 'off' | AudioContextState {
    return this.ctx ? this.ctx.state : 'off';
  }
  get voiceCount(): number {
    return this.voices.length;
  }

  /** Create (first call) and resume the context. MUST be called from a user gesture. */
  async enable(): Promise<void> {
    if (!this.ctx) {
      const make = this.o.createContext ?? (() => new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ latencyHint: 'interactive' }));
      this.ctx = make();
      this.chain = buildMasterChain(this.ctx, this.volume);
      this.noise = makeNoise(this.ctx, 3, this.rand);
    }
    this.active = true;
    await this.ctx.resume();
    this.startTimer();
  }

  /** Called on visibility / layer changes: suspends the context (no CPU when silent) or resumes it. */
  async setActive(on: boolean): Promise<void> {
    this.active = on;
    if (!this.ctx) return;
    if (on) {
      await this.ctx.resume().catch(() => undefined);
      this.startTimer();
    } else {
      this.stopTimer();
      this.pending.length = 0;
      await this.ctx.suspend().catch(() => undefined);
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && this.chain) this.chain.master.gain.setTargetAtTime(volumeToGain(v), this.ctx.currentTime, 0.03);
  }

  /** Queue a strike; whether it actually sounds is decided at the next flush (priority + rate cap + voice limit). */
  strike(s: StrikeSound): void {
    if (!this.active || !this.ctx || this.ctx.state !== 'running') return;
    const p = thunderParams(s.km, s.energyFj, s.pan);
    if (voiceScore(p) <= 0.002) return;
    if (this.pending.length > 400) this.pending.splice(0, 100); // never grow without bound under a flood
    this.pending.push(p);
  }

  /** One scheduling pass (called every 150 ms; exposed for tests). */
  flush(): void {
    const ctx = this.ctx;
    if (!ctx || !this.chain || !this.noise || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    const budget = this.bucket.available();
    const pick = selectForBurst(batch.map(voiceScore), budget);
    this.stats.dropped += batch.length - pick.length;
    this.bucket.take(pick.length);
    this.reap();
    for (const i of pick) {
      const p = batch[i]!;
      const score = voiceScore(p);
      const steal = voiceToSteal(this.voices.map((v) => v.score), score, this.maxVoices);
      if (steal === -1) {
        this.stats.dropped++;
        continue;
      }
      if (steal >= 0) this.drop(steal);
      const r = renderThunder(ctx, this.chain.input, p, this.noise, this.rand);
      this.voices.push({ r, score });
      this.stats.played++;
    }
  }

  dispose(): void {
    this.stopTimer();
    for (const v of this.voices) v.r.stop();
    this.voices = [];
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.chain = null;
  }

  private reap(): void {
    const t = this.ctx?.currentTime ?? 0;
    this.voices = this.voices.filter((v) => {
      if (v.r.end + 0.1 > t) return true;
      v.r.stop();
      return false;
    });
  }
  private drop(i: number): void {
    const v = this.voices[i]!;
    const t = this.ctx!.currentTime;
    v.r.gain.gain.cancelScheduledValues(t);
    v.r.gain.gain.setTargetAtTime(0, t, 0.02);
    setTimeout(() => v.r.stop(), 150);
    this.voices.splice(i, 1);
    this.stats.stolen++;
  }
  private startTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.flush(), 150);
  }
  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
