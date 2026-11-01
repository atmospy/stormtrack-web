/** Saffir-Simpson helpers and colours (wind in knots, 1-minute sustained). */

export interface Category {
  /** 0 = TD, 1 = TS, 2..6 = category 1..5 */
  rank: number;
  label: string;
  name: string;
  color: string;
}

export const CATEGORIES: readonly Category[] = [
  { rank: 0, label: 'TD', name: 'Tropical depression', color: '#5ec8ff' },
  { rank: 1, label: 'TS', name: 'Tropical storm', color: '#3de0b0' },
  { rank: 2, label: 'C1', name: 'Category 1', color: '#ffe14d' },
  { rank: 3, label: 'C2', name: 'Category 2', color: '#ffb03b' },
  { rank: 4, label: 'C3', name: 'Category 3 (major)', color: '#ff7a3b' },
  { rank: 5, label: 'C4', name: 'Category 4 (major)', color: '#ff3b5c' },
  { rank: 6, label: 'C5', name: 'Category 5 (major)', color: '#e04bff' }
];

/** Saffir-Simpson category rank from 1-minute sustained wind in knots. */
export function categoryFromWind(kt: number | null | undefined): Category {
  if (kt == null || !Number.isFinite(kt) || kt < 34) return CATEGORIES[0]!;
  if (kt < 64) return CATEGORIES[1]!;
  if (kt < 83) return CATEGORIES[2]!;
  if (kt < 96) return CATEGORIES[3]!;
  if (kt < 113) return CATEGORIES[4]!;
  if (kt < 137) return CATEGORIES[5]!;
  return CATEGORIES[6]!;
}

/** Normalise a contract label (TD, TS, C1..C5, H1..H5, STY, ...) to a Category; falls back to wind. */
export function categoryFromLabel(label: string | null | undefined, windKt?: number | null): Category {
  const l = (label ?? '').trim().toUpperCase();
  if (l === 'TD' || l === 'DB' || l === 'LO' || l === 'SD') return CATEGORIES[0]!;
  if (l === 'TS' || l === 'STS') return CATEGORIES[1]!;
  const m = /^[CH]([1-5])$/.exec(l);
  if (m) return CATEGORIES[Number(m[1]) + 1]!;
  if (l === 'STY') return CATEGORIES[4]!;
  if (l === 'TY' || l === 'HU') return categoryFromWind(windKt ?? 64);
  return categoryFromWind(windKt);
}

export function colorFor(label: string | null | undefined, windKt?: number | null): string {
  return categoryFromLabel(label, windKt).color;
}

export const KT_TO_MS = 0.514444;
export const MS_TO_KT = 1 / KT_TO_MS;
export const ktToKmh = (kt: number) => kt * 1.852;
export const msToKmh = (ms: number) => ms * 3.6;

/** Beaufort number and name from m/s. */
export function beaufort(ms: number): { n: number; name: string } {
  const lim = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const names = ['Calm', 'Light air', 'Light breeze', 'Gentle breeze', 'Moderate breeze', 'Fresh breeze', 'Strong breeze', 'Near gale', 'Gale', 'Strong gale', 'Storm', 'Violent storm', 'Hurricane force'];
  let n = 0;
  while (n < lim.length && ms >= lim[n]!) n++;
  return { n, name: names[n]! };
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]!;
}

/** Meteorological direction (the direction the wind blows FROM, degrees clockwise from north). */
export function windFromDeg(u: number, v: number): number {
  return (((270 - (Math.atan2(v, u) * 180) / Math.PI) % 360) + 360) % 360;
}

/** Great-circle distance (km) and initial bearing (deg). */
export function distBearing(lon1: number, lat1: number, lon2: number, lat2: number): { km: number; bearing: number } {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dLon) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  return { km, bearing: (((Math.atan2(y, x) / r) % 360) + 360) % 360 };
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const min = Math.round((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(min)) return 'unknown';
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
