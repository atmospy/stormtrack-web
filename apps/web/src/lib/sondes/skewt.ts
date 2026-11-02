/** Skew-T log-p geometry and the ascent profile of one radiosonde. Pure functions, no DOM. */

export interface Profile {
  /** pressure hPa, decreasing with height */
  p: number[];
  /** air temperature degC */
  t: number[];
  /** dew point degC, null where humidity was not usable */
  td: (number | null)[];
  /** height m above sea level */
  alt: number[];
  /** wind speed m/s and the direction it blows FROM (deg), null when unknown */
  ws: (number | null)[];
  wd: (number | null)[];
  /** height of the highest packet (burst) and whether the sonde is still going up */
  maxAlt: number;
  ascending: boolean;
  /** true when the sonde sent no pressure and it was worked out from height and temperature */
  pressureEstimated: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Dew point (degC) from temperature (degC) and relative humidity (%), Magnus formula over water. */
export function dewPoint(t: number, rh: number): number | null {
  if (!(rh > 0) || rh > 100.5) return null;
  const a = 17.625, b = 243.04;
  const g = Math.log(rh / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

/** Wind (speed m/s, from-direction deg) from a sonde's horizontal speed and the heading it is travelling. */
export function windFrom(velH: number | null, heading: number | null): { ws: number; wd: number } | null {
  if (velH === null || heading === null || velH < 0) return null;
  return { ws: velH, wd: (heading + 180) % 360 };
}

/** ISA pressure (hPa) at a height (m), used to start the hydrostatic integration at the launch site. */
export const isaPressure = (altM: number): number => 1013.25 * Math.pow(1 - 2.25577e-5 * altM, 5.25588);

/**
 * Pressure (hPa) at each height from the hydrostatic equation with the sonde's own temperatures, starting from the
 * ISA pressure at the first height. Good to about 1 % in pressure, which is a small shift on a log-p axis; it ignores
 * humidity, so it is slightly high in moist air.
 */
export function hydrostaticPressure(alt: number[], tC: number[]): number[] {
  const g = 9.80665, R = 287.05;
  const p = [isaPressure(alt[0]!)];
  for (let i = 1; i < alt.length; i++) {
    const tm = (tC[i]! + tC[i - 1]!) / 2 + 273.15;
    p.push(p[i - 1]! * Math.exp((-g * (alt[i]! - alt[i - 1]!)) / (R * tm)));
  }
  return p;
}

/**
 * The ascent profile from SondeHub's telemetry (`{serial: {datetime: packet}}`, or a list of packets): packets with
 * pressure and temperature up to the highest point, thinned to about one per 2 hPa so a 7 000-packet flight draws
 * quickly. Sondes that send no pressure get it from height and temperature (`pressureEstimated`). Dew point is kept only where humidity exists and the pressure is at least 250 hPa, above which
 * the humidity sensor is not meaningful.
 */
export function buildProfile(raw: unknown, serial: string): Profile | null {
  let packets: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) packets = raw as Record<string, unknown>[];
  else if (raw && typeof raw === 'object') {
    const per = (raw as Record<string, unknown>)[serial];
    if (per && typeof per === 'object') packets = Object.values(per as Record<string, unknown>) as Record<string, unknown>[];
  }
  const rows = packets
    .map((r) => ({ time: typeof r.datetime === 'string' ? Date.parse(r.datetime) : NaN, p: num(r.pressure), t: num(r.temp), rh: num(r.humidity), alt: num(r.alt), vh: num(r.vel_h), hd: num(r.heading) }))
    .filter((r) => Number.isFinite(r.time) && r.t !== null && r.alt !== null && r.t > -120 && r.t < 60)
    .sort((a, b) => a.time - b.time);
  if (rows.length < 3) return null;
  const withP = rows.filter((r) => r.p !== null && r.p > 0).length;
  const estimated = withP < rows.length * 0.6;
  let top = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i]!.alt! > rows[top]!.alt!) top = i;
  const up = rows.slice(0, top + 1);
  if (estimated) {
    const ps = hydrostaticPressure(up.map((r) => r.alt!), up.map((r) => r.t!));
    up.forEach((r, i) => (r.p = ps[i]!));
  } else {
    for (let i = up.length - 1; i >= 0; i--) if (!(up[i]!.p! > 0)) up.splice(i, 1);
  }
  const out: Profile = { p: [], t: [], td: [], alt: [], ws: [], wd: [], maxAlt: rows[top]!.alt!, ascending: top >= rows.length - 3, pressureEstimated: estimated };
  let lastP = Infinity;
  for (const r of up) {
    if (lastP - r.p! < 2 && out.p.length) continue; // one point per 2 hPa; also drops non-monotonic noise
    lastP = r.p!;
    const w = windFrom(r.vh, r.hd);
    out.p.push(r.p!);
    out.t.push(r.t!);
    out.td.push(r.rh !== null && r.p! >= 250 ? dewPoint(r.t!, r.rh) : null);
    out.alt.push(r.alt!);
    out.ws.push(w?.ws ?? null);
    out.wd.push(w?.wd ?? null);
  }
  return out.p.length >= 3 ? out : null;
}

export interface Frame {
  w: number;
  h: number;
  pBottom: number;
  pTop: number;
  tMin: number;
  span: number;
  /** degC the isotherms lean by over the full height */
  skew: number;
}

/** Pressure at the top of the plot: the first round level at or above the highest pressure reading. */
export function topPressure(minP: number): number {
  return [500, 300, 200, 100, 50, 20, 10, 5].find((x) => x <= minP) ?? 5;
}

export const frameFor = (w: number, h: number, minP: number): Frame => ({ w, h, pBottom: 1050, pTop: topPressure(minP), tMin: -40, span: 90, skew: 70 });

/** Vertical fraction 0 (bottom) to 1 (top) of a pressure on the log-p axis. */
export const yFrac = (f: Frame, p: number): number => Math.log(f.pBottom / p) / Math.log(f.pBottom / f.pTop);

/** Plot position of a temperature at a pressure: x grows right, y grows downward (SVG). */
export function project(f: Frame, tC: number, p: number): { x: number; y: number } {
  const fr = yFrac(f, p);
  return { x: ((tC - f.tMin + f.skew * fr) / f.span) * f.w, y: (1 - fr) * f.h };
}

/** Temperature (degC) of a dry adiabat with potential temperature `thetaK` at pressure `p`. */
export const dryAdiabat = (thetaK: number, p: number): number => thetaK * Math.pow(p / 1000, 0.2857) - 273.15;

/** SVG path for a wind barb: staff from (0,0) toward the direction the wind comes from, rotated by the caller. */
export function barbPath(kt: number, len = 26): string {
  let n = Math.round(kt / 5) * 5;
  if (n === 0) return 'M-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0';
  let d = `M0 0L0 ${-len}`;
  let y = -len;
  const step = 4.2;
  while (n >= 50) {
    d += `M0 ${y}L8 ${y + 2.4}L0 ${y + 5}`;
    y += 5.5;
    n -= 50;
  }
  while (n >= 10) {
    d += `M0 ${y}L8 ${y - 3}`;
    y += step;
    n -= 10;
  }
  if (n >= 5) {
    if (y === -len) y += step;
    d += `M0 ${y}L4 ${y - 1.5}`;
  }
  return d;
}
