import type { Flashes, LightningIndex, Recent, Strike } from '#lib/data/lightning';

/**
 * DEMO MODE: a simulated storm feed that goes through exactly the same pipeline as the real recent.json
 * (poller -> player -> layer + sound). It is a pure function of time, so any window can be generated
 * deterministically, the 60-minute backlog included. Clearly labelled SIMULATED everywhere it is shown.
 *
 * Contents: four moving storm cells over the Americas (GOES-like, with energies), pulsing and with short bursts,
 * plus a tiny India cluster (IITM-like: no energy, 4-dp positions).
 */

interface Cell {
  lon: number;
  lat: number;
  /** half-amplitude of the drift (deg) and its period (s) */
  ampLon: number;
  ampLat: number;
  period: number;
  /** spread (deg, gaussian sigma) */
  sigma: number;
  /** mean strikes per second */
  rate: number;
  phase: number;
  src: 0 | 1;
}
export const DEMO_CELLS: readonly Cell[] = [
  { lon: -88.5, lat: 28.6, ampLon: 5, ampLat: 1.5, period: 2400, sigma: 0.9, rate: 2.2, phase: 0.3, src: 0 },
  { lon: -97.2, lat: 35.4, ampLon: 3, ampLat: 2.5, period: 1900, sigma: 0.7, rate: 1.8, phase: 2.1, src: 0 },
  { lon: -60.5, lat: -3.5, ampLon: 4, ampLat: 3, period: 3100, sigma: 1.8, rate: 2.4, phase: 4.0, src: 0 },
  { lon: -62.2, lat: -32.4, ampLon: 3, ampLat: 1.5, period: 2700, sigma: 1.1, rate: 1.2, phase: 5.2, src: 0 },
  { lon: 73.9, lat: 18.6, ampLon: 0.6, ampLat: 0.3, period: 1500, sigma: 0.22, rate: 0.35, phase: 1.0, src: 1 }
];

const TAU = Math.PI * 2;

/** fast deterministic hash -> [0,1) generator seeded from two ints */
function rng(a: number, b: number): () => number {
  let s = (Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(TAU * r());
function poisson(lambda: number, r: () => number): number {
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss(r)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= r();
  } while (p > L);
  return k - 1;
}
const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/** how much stronger than average the cell is at time t (seconds): slow pulse x short bursts every ~100 s */
export function cellIntensity(c: Cell, tSec: number): number {
  const pulse = 0.65 + 0.35 * Math.sin((TAU * tSec) / 420 + c.phase);
  const burstPhase = ((tSec + c.phase * 17) % 110) / 110;
  const burst = burstPhase < 0.09 ? 4 : 1; // ~10 s of 4x
  return pulse * burst;
}
export function cellCentre(c: Cell, tSec: number): { lon: number; lat: number } {
  return { lon: c.lon + c.ampLon * Math.sin((TAU * tSec) / c.period + c.phase), lat: c.lat + c.ampLat * Math.sin((TAU * tSec) / (c.period * 1.3) + c.phase * 2) };
}

/** all simulated strikes with fromMs <= t < toMs, sorted by time */
export function demoStrikes(fromMs: number, toMs: number, seed = 7): Strike[] {
  const out: Strike[] = [];
  for (let sec = Math.floor(fromMs / 1000); sec * 1000 < toMs; sec++) {
    DEMO_CELLS.forEach((c, ci) => {
      const r = rng(sec * 31 + seed, ci + 1);
      const n = poisson(c.rate * cellIntensity(c, sec), r);
      if (!n) return;
      const ctr = cellCentre(c, sec);
      for (let k = 0; k < n; k++) {
        const t = sec * 1000 + Math.floor(r() * 1000);
        if (t < fromMs || t >= toMs) continue;
        const lon = Math.round((ctr.lon + gauss(r) * c.sigma) * (c.src ? 1e4 : 1e2)) / (c.src ? 1e4 : 1e2);
        const lat = Math.round((ctr.lat + gauss(r) * c.sigma * 0.8) * (c.src ? 1e4 : 1e2)) / (c.src ? 1e4 : 1e2);
        // GOES-like energies: log-normal around ~40 fJ, a few strong ones; the India feed reports none
        const e = c.src ? null : Math.max(1, Math.min(4000, Math.round(Math.exp(Math.log(40) + 1.2 * gauss(r)))));
        let h = 2166136261 ^ c.src;
        for (const v of [t, Math.round(lon * 1e4), Math.round(lat * 1e4)]) h = Math.imul(h ^ (v & 0xffff), 16777619) ^ Math.imul(h ^ (v >>> 16), 2246822519);
        out.push({ id: hex8(h), t_ms: t, lon, lat, energy_fj: e, src: c.src });
      }
    });
  }
  out.sort((a, b) => a.t_ms - b.t_ms);
  return out;
}

export const DEMO_LATENCY_S = 45;
export const DEMO_PUBLISH_S = 20;
export const DEMO_DELAY_S = 75;

/**
 * What a recent.json published "now" would contain: the file is regenerated every 20 s (so strikes arrive in
 * lumps, like the real feed) and holds the last `windowS` seconds up to the feed latency.
 */
export function demoRecent(nowMs: number, windowS = 180, seed = 7): Recent {
  const gen = Math.floor(nowMs / (DEMO_PUBLISH_S * 1000)) * DEMO_PUBLISH_S * 1000;
  return { generated: new Date(gen).toISOString(), window_s: windowS, strikes: demoStrikes(gen - windowS * 1000, gen - DEMO_LATENCY_S * 1000, seed) };
}

export function demoIndex(nowMs: number): LightningIndex {
  const iso = new Date(Math.floor(nowMs / 1000) * 1000).toISOString();
  const src = (id: string, name: string, extra: Partial<LightningIndex['sources'][number]> = {}): LightningIndex['sources'][number] => ({
    id, name, licence: 'Simulated data, not real lightning', satellites: [], latency_s: DEMO_LATENCY_S, coverage: null,
    attribution: 'SIMULATED storm feed for demonstration, not real lightning', kind: 'simulated', time_precision: 'exact', time_uncertainty_s: 0, unofficial: false, stale: false, updated: iso, ...extra
  });
  return {
    schema: 1, generated: iso, updated: iso, window_minutes: 60, count: 0, stale: false, keepFraction: 1,
    live: { delay_s: DEMO_DELAY_S, poll_s: 15 },
    sources: [src('demo-goes', 'Simulated storms (GOES-like)'), src('demo-iitm', 'Simulated India cluster (IITM-like)', { time_precision: 'exact' })],
    notes: 'DEMO MODE: every strike shown here is simulated.'
  };
}

/** The 60-minute backlog as Flashes columns (up to `untilMs`). */
export function demoFlashes(nowMs: number, untilMs: number, minutes = 60, seed = 7): Flashes {
  const from = nowMs - minutes * 60_000;
  const s = demoStrikes(from, untilMs, seed);
  const n = s.length;
  const f: Flashes = { t0: from, n, dt: new Float32Array(n), lon: new Float32Array(n), lat: new Float32Array(n), energy: new Float32Array(n), src: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const x = s[i]!;
    f.dt[i] = (x.t_ms - from) / 1000;
    f.lon[i] = x.lon;
    f.lat[i] = x.lat;
    f.energy[i] = x.energy_fj ?? 0;
    f.src[i] = x.src;
  }
  return f;
}

export function demoCoverage(): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const box = (w: number, s: number, e: number, n: number, source: string): GeoJSON.Feature<GeoJSON.Polygon> => ({
    type: 'Feature', properties: { source, approximate: true, basis: 'demo extent' },
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }
  });
  return { type: 'FeatureCollection', features: [box(-130, -52, -28, 55, 'demo-goes'), box(66, 5, 100, 36, 'demo-iitm')] };
}
