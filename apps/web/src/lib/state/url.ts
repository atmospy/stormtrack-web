/**
 * Shareable view state <-> query string. Pure (no DOM) so it is unit-testable.
 * Everything is optional: a missing or invalid parameter simply falls back to the app default.
 *   ?c=18.00,80.00,3.2&m=gfs&f=wind&l=850&t=20261101T12&on=wind,storms&s=a:IO042026&lw=15&pin=19.1,72.8
 */
export const LAYER_KEYS = ['wind', 'storms', 'history', 'events', 'quakes', 'fires', 'lightning', 'nowcast', 'satellite'] as const;
export type ShareLayer = (typeof LAYER_KEYS)[number];
export const VARIABLE_KEYS = ['wind', 'pressure', 'temperature', 'precipitation'] as const;
export const LIGHTNING_WINDOWS = [5, 15, 60] as const;

export interface ShareState {
  lat?: number;
  lon?: number;
  zoom?: number;
  model?: string;
  variable?: (typeof VARIABLE_KEYS)[number];
  level?: string;
  /** valid time, epoch ms */
  t?: number;
  layers?: ShareLayer[];
  /** wind particles over a scalar field */
  overlay?: boolean;
  selection?: { type: 'active' | 'history'; id: string };
  lightningWindow?: (typeof LIGHTNING_WINDOWS)[number];
  /** "Reduce flashing" accessibility setting (sound is deliberately NOT part of the URL: it needs a click) */
  reduceFlashing?: boolean;
  pin?: { lon: number; lat: number };
  basins?: string[];
  years?: [number, number];
  minCategory?: number;
}

const r = (v: number, d: number) => String(Number(v.toFixed(d)));

export function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 11); // 20261101T12
}
export function parseTime(s: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})?$/.exec(s);
  if (!m) return undefined;
  const ms = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +(m[5] ?? 0));
  return Number.isFinite(ms) ? ms : undefined;
}

export function serialize(s: ShareState): string {
  const q = new URLSearchParams();
  if (s.lat !== undefined && s.lon !== undefined && s.zoom !== undefined) q.set('c', `${r(s.lat, 3)},${r(s.lon, 3)},${r(s.zoom, 2)}`);
  if (s.model) q.set('m', s.model);
  if (s.variable) q.set('f', s.variable);
  if (s.level) q.set('l', s.level);
  if (s.t !== undefined) q.set('t', formatTime(s.t));
  if (s.overlay) q.set('ov', '1');
  if (s.layers) q.set('on', s.layers.join(',') || '-');
  if (s.selection) q.set('s', `${s.selection.type === 'active' ? 'a' : 'h'}:${s.selection.id}`);
  if (s.lightningWindow) q.set('lw', String(s.lightningWindow));
  if (s.reduceFlashing) q.set('rf', '1');
  if (s.pin) q.set('pin', `${r(s.pin.lat, 3)},${r(s.pin.lon, 3)}`);
  if (s.basins) q.set('hb', s.basins.join(',') || '-');
  if (s.years) q.set('hy', `${s.years[0]}-${s.years[1]}`);
  if (s.minCategory !== undefined && s.minCategory > 0) q.set('hc', String(s.minCategory));
  return q.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}

const finite = (x: string | undefined): number | undefined => {
  if (x === undefined || x.trim() === '') return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};

export function parse(search: string): ShareState {
  const q = new URLSearchParams(search.startsWith('?') || search.startsWith('#') ? search.slice(1) : search);
  const out: ShareState = {};
  const c = q.get('c')?.split(',');
  if (c && c.length === 3) {
    const lat = finite(c[0]), lon = finite(c[1]), zoom = finite(c[2]);
    if (lat !== undefined && lon !== undefined && zoom !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 720) {
      out.lat = lat;
      out.lon = ((((lon + 180) % 360) + 360) % 360) - 180;
      out.zoom = Math.min(22, Math.max(0, zoom));
    }
  }
  const tok = (k: string, re: RegExp) => {
    const v = q.get(k);
    return v && re.test(v) ? v : undefined;
  };
  const m = tok('m', /^[a-z0-9][a-z0-9-]{0,31}$/);
  if (m) out.model = m;
  const f = q.get('f');
  if (f && (VARIABLE_KEYS as readonly string[]).includes(f)) out.variable = f as ShareState['variable'];
  const l = tok('l', /^(\d{1,4}m?|\d{3,4})$/);
  if (l) out.level = l;
  const t = q.get('t');
  if (t) {
    const ms = parseTime(t);
    if (ms !== undefined) out.t = ms;
  }
  if (q.get('ov') === '1') out.overlay = true;
  const on = q.get('on');
  if (on !== null) out.layers = on.split(',').filter((k): k is ShareLayer => (LAYER_KEYS as readonly string[]).includes(k));
  const s = q.get('s');
  const sm = s && /^([ah]):([A-Za-z0-9_.\-]{1,40})$/.exec(s);
  if (sm) out.selection = { type: sm[1] === 'a' ? 'active' : 'history', id: sm[2]! };
  const lw = finite(q.get('lw') ?? undefined);
  if (lw !== undefined && (LIGHTNING_WINDOWS as readonly number[]).includes(lw)) out.lightningWindow = lw as ShareState['lightningWindow'];
  if (q.get('rf') === '1') out.reduceFlashing = true;
  const pin = q.get('pin')?.split(',');
  if (pin && pin.length === 2) {
    const la = finite(pin[0]), lo = finite(pin[1]);
    if (la !== undefined && lo !== undefined && Math.abs(la) <= 90 && Math.abs(lo) <= 180) out.pin = { lat: la, lon: lo };
  }
  const hb = q.get('hb');
  if (hb !== null) out.basins = hb.split(',').filter((b) => /^[A-Z]{2}$/.test(b));
  const hy = /^(\d{4})-(\d{4})$/.exec(q.get('hy') ?? '');
  if (hy && +hy[1]! <= +hy[2]!) out.years = [+hy[1]!, +hy[2]!];
  const hc = finite(q.get('hc') ?? undefined);
  if (hc !== undefined && Number.isInteger(hc) && hc >= 0 && hc <= 6) out.minCategory = hc;
  return out;
}
