import { isGlobalLon } from './decode.js';
import type { DecodedScalar, IsobarOptions, IsobarResult } from './types.js';

type Pt = [number, number];
/** A contour polyline in UNWRAPPED grid coordinates (fx may leave [0,w) on global grids; never jumps by ~w). */
interface Chain {
  pts: Pt[];
  closed: boolean;
}

/** Per-level segment store. */
class Level {
  segA: number[] = [];
  segB: number[] = [];
  crossing = new Map<number, Pt>();
  adj = new Map<number, number[]>();
  link(e1: number, e2: number): void {
    const s = this.segA.length;
    this.segA.push(e1);
    this.segB.push(e2);
    (this.adj.get(e1) ?? this.adj.set(e1, []).get(e1)!).push(s);
    (this.adj.get(e2) ?? this.adj.set(e2, []).get(e2)!).push(s);
  }
}

/**
 * Marching squares for all levels `levelOf(k)`, k in [k0,k1], in ONE pass over the grid: each cell only visits the
 * levels between its own min and max. Edge crossings are identified by edge id (i mod w on periodic grids), so rings
 * that cross the +-180 seam close without any special casing.
 */
function contourAll(values: Float32Array, w: number, h: number, periodic: boolean, base: number, interval: number, k0: number, k1: number, levelOf: (k: number) => number): Map<number, Chain[]> {
  const cols = periodic ? w : w - 1;
  const nH = w * h; // horizontal edge (i,j)-(i+1,j): id = j*w + i ; vertical edge (i,j)-(i,j+1): id = nH + j*w + i
  const levels = new Map<number, Level>();

  for (let j = 0; j < h - 1; j++) {
    const r0 = j * w, r1 = r0 + w;
    for (let i = 0; i < cols; i++) {
      const i1 = periodic && i + 1 === w ? 0 : i + 1;
      const tl = values[r0 + i]!, tr = values[r0 + i1]!, br = values[r1 + i1]!, bl = values[r1 + i]!;
      if (tl !== tl || tr !== tr || br !== br || bl !== bl) continue;
      const lo = Math.min(tl, tr, br, bl);
      const hi = Math.max(tl, tr, br, bl);
      const ka = Math.max(k0, Math.floor((lo - base) / interval) - 1);
      const kb = Math.min(k1, Math.floor((hi - base) / interval) + 1);
      for (let k = ka; k <= kb; k++) {
        const level = levelOf(k);
        const code = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
        if (code === 0 || code === 15) continue;
        let L = levels.get(k);
        if (!L) levels.set(k, (L = new Level()));
        const cr = L.crossing;
        const hEdge = (jj: number, a: number, b: number): number => {
          const id = jj * w + i;
          if (!cr.has(id)) cr.set(id, [i + (level - a) / (b - a), jj]);
          return id;
        };
        const vEdge = (ii: number, a: number, b: number): number => {
          const id = nH + j * w + (ii % w);
          if (!cr.has(id)) cr.set(id, [ii, j + (level - a) / (b - a)]);
          return id;
        };
        const top = () => hEdge(j, tl, tr);
        const bottom = () => hEdge(j + 1, bl, br);
        const left = () => vEdge(i, tl, bl);
        const right = () => vEdge(i + 1, tr, br);
        switch (code) {
          case 1: case 14: L.link(left(), bottom()); break;
          case 2: case 13: L.link(bottom(), right()); break;
          case 3: case 12: L.link(left(), right()); break;
          case 4: case 11: L.link(top(), right()); break;
          case 6: case 9: L.link(top(), bottom()); break;
          case 7: case 8: L.link(left(), top()); break;
          case 5:
          case 10: {
            const centreHigh = (tl + tr + br + bl) / 4 >= level;
            // code 5: tr & bl high. centre high -> the highs connect, so lows are cut off at tl and br corners
            if ((code === 5) === centreHigh) { L.link(left(), top()); L.link(bottom(), right()); }
            else { L.link(left(), bottom()); L.link(top(), right()); }
            break;
          }
        }
      }
    }
  }
  const out = new Map<number, Chain[]>();
  for (const [k, L] of levels) out.set(k, chain(L, w, periodic));
  return out;
}

function chain(L: Level, w: number, periodic: boolean): Chain[] {
  const { segA, segB, crossing, adj } = L;
  const used = new Uint8Array(segA.length);
  const chains: Chain[] = [];
  const unwrapped = (e: number, prev: Pt | null): Pt => {
    const p = crossing.get(e)!;
    let x = p[0];
    if (periodic && prev) {
      x = ((x % w) + w) % w;
      while (x - prev[0] > w / 2) x -= w;
      while (prev[0] - x > w / 2) x += w;
    } else if (periodic) x = ((x % w) + w) % w;
    return [x, p[1]];
  };
  const walk = (startSeg: number, startEdge: number): Chain => {
    const pts: Pt[] = [unwrapped(startEdge, null)];
    let seg = startSeg;
    let from = startEdge;
    let closed = false;
    for (;;) {
      used[seg] = 1;
      const to = segA[seg] === from ? segB[seg]! : segA[seg]!;
      pts.push(unwrapped(to, pts[pts.length - 1]!));
      if (to === startEdge) { closed = true; break; }
      const nxt = (adj.get(to) ?? []).find((s) => !used[s]);
      if (nxt === undefined) break;
      seg = nxt;
      from = to;
    }
    return { pts, closed };
  };
  // open chains first (start at an endpoint with a single segment), then rings
  for (const [e, list] of adj) {
    if (list.length === 1 && !used[list[0]!]) chains.push(walk(list[0]!, e));
  }
  for (let s = 0; s < segA.length; s++) {
    if (!used[s]) chains.push(walk(s, segA[s]!));
  }
  return chains;
}

function chaikin(pts: Pt[], closed: boolean, iters: number): Pt[] {
  let p = pts;
  // A line that encircles the globe is "closed" on the sphere but its end points differ by a full grid width in
  // x. Corner-cutting across that jump would draw a world-spanning chord, so treat it as an open line.
  if (closed && pts.length > 1) {
    const a = pts[0]!, b = pts[pts.length - 1]!;
    if (Math.abs(a[0] - b[0]) > 1e-9 || Math.abs(a[1] - b[1]) > 1e-9) closed = false;
  }
  for (let it = 0; it < iters; it++) {
    const n = closed ? p.length - 1 : p.length;
    if (n < 3) break;
    const out: Pt[] = [];
    if (!closed) out.push(p[0]!);
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = p[i]!, b = p[(i + 1) % n]!;
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) out.push(p[n - 1]!);
    else out.push(out[0]!);
    p = out;
  }
  return p;
}

const wrap180 = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Split a lon/lat polyline wherever it crosses +-180; coordinates are returned in [-180,180]. */
export function splitAtAntimeridian(line: Pt[], closed = false): Pt[][] {
  const parts: Pt[][] = [];
  let cur: Pt[] = [];
  // work on the continuous (unwrapped) longitudes; a boundary is at lon = 180 + 360k
  let prev = line[0]!;
  cur.push([wrap180(prev[0]), prev[1]]);
  // 'wrap180' maps exactly +180 to -180; keep points sitting on the boundary on the side they came from
  for (let i = 1; i < line.length; i++) {
    const p = line[i]!;
    const kPrev = Math.floor((prev[0] + 180) / 360);
    const kCur = Math.floor((p[0] + 180) / 360);
    if (kPrev !== kCur) {
      const dir = kCur > kPrev ? 1 : -1;
      // visit each boundary between kPrev and kCur
      for (let k = kPrev; k !== kCur; k += dir) {
        const bx = 180 + 360 * (dir > 0 ? k : k - 1);
        const t = (bx - prev[0]) / (p[0] - prev[0]);
        const by = prev[1] + (p[1] - prev[1]) * t;
        cur.push([dir > 0 ? 180 : -180, by]);
        if (cur.length > 1) parts.push(cur);
        cur = [[dir > 0 ? -180 : 180, by]];
      }
    }
    cur.push([wrap180(p[0]), p[1]]);
    prev = p;
  }
  if (cur.length > 1) parts.push(cur);
  // a closed ring that starts mid-way: its last and first pieces are one continuous piece
  if (closed && parts.length > 1) {
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    if (first[0]![0] === last[last.length - 1]![0] && first[0]![1] === last[last.length - 1]![1]) {
      parts.shift();
      parts[parts.length - 1] = last.concat(first.slice(1));
    }
  }
  return parts;
}

const arcLen = (a: Pt, b: Pt) => Math.hypot((b[0] - a[0]) * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180), b[1] - a[1]);

/** Upright text rotation (deg clockwise from east, MapLibre `text-rotate`) of segment a->b in mercator-ish screen space. */
function textAngle(a: Pt, b: Pt): number {
  const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.min(Math.max(lat, -85), 85) * Math.PI) / 360)) * (180 / Math.PI);
  let ang = (Math.atan2(-(merc(b[1]) - merc(a[1])), b[0] - a[0]) * 180) / Math.PI;
  if (ang > 90) ang -= 180;
  else if (ang < -90) ang += 180;
  return Math.round(ang * 10) / 10;
}

function extrema(d: DecodedScalar, radiusDeg: number, minDelta: number): Array<{ type: 'H' | 'L'; value: number; lon: number; lat: number }> {
  const { width: w, height: h, values } = d;
  const periodic = isGlobalLon(d);
  const dx = (d.lon_right - d.lon_left) / (w - 1);
  const dy = (d.lat_top - d.lat_bottom) / (h - 1);
  const rx = Math.max(1, Math.round(radiusDeg / dx));
  const ry = Math.max(1, Math.round(radiusDeg / dy));
  // search on a decimated grid (window ~ +-6 samples) so cost is independent of grid resolution, then refine on the full grid
  const sx = Math.max(1, Math.floor(rx / 6));
  const sy = Math.max(1, Math.floor(ry / 6));
  const W = Math.ceil(w / sx), H = Math.ceil(h / sy);
  const dec = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) dec[j * W + i] = values[Math.min(j * sy, h - 1) * w + Math.min(i * sx, w - 1)]!;
  const rX = Math.max(1, Math.round(rx / sx)), rY = Math.max(1, Math.round(ry / sy));
  const run = (src: Float32Array, rows: number, cols: number, r: number, alongRow: boolean, wrap: boolean, isMax: boolean): Float32Array => {
    const out = new Float32Array(src.length);
    const len = alongRow ? cols : rows;
    const lines = alongRow ? rows : cols;
    for (let a = 0; a < lines; a++) {
      for (let b = 0; b < len; b++) {
        let best = isMax ? -Infinity : Infinity;
        for (let o = -r; o <= r; o++) {
          let bb = b + o;
          if (bb < 0 || bb >= len) {
            if (!wrap) continue;
            bb = ((bb % len) + len) % len;
          }
          const v = alongRow ? src[a * cols + bb]! : src[bb * cols + a]!;
          if (v === v && (isMax ? v > best : v < best)) best = v;
        }
        if (alongRow) out[a * cols + b] = best;
        else out[b * cols + a] = best;
      }
    }
    return out;
  };
  const maxD = run(run(dec, H, W, rX, true, periodic, true), H, W, rY, false, false, true);
  const minD = run(run(dec, H, W, rX, true, periodic, false), H, W, rY, false, false, false);
  const found: Array<{ type: 'H' | 'L'; value: number; lon: number; lat: number; i: number; j: number }> = [];
  const near = (i: number, j: number, type: string) =>
    found.some((f) => f.type === type && Math.abs(f.j - j) <= ry && (Math.abs(f.i - i) <= rx || (periodic && w - Math.abs(f.i - i) <= rx)));
  for (let J = 1; J < H - 1; J++) {
    for (let I = 0; I < W; I++) {
      const v = dec[J * W + I]!;
      const idx = J * W + I;
      const isH = v === maxD[idx] && v - minD[idx]! >= minDelta;
      const isL = !isH && v === minD[idx] && maxD[idx]! - v >= minDelta;
      if (!isH && !isL) continue;
      // refine: best sample of the full grid within the decimation cell neighbourhood
      let bi = I * sx, bj = J * sy, bv = values[Math.min(bj, h - 1) * w + Math.min(bi, w - 1)]!;
      for (let jj = Math.max(1, J * sy - sy); jj <= Math.min(h - 2, J * sy + sy); jj++) {
        for (let ii = I * sx - sx; ii <= I * sx + sx; ii++) {
          const i2 = periodic ? ((ii % w) + w) % w : Math.min(Math.max(ii, 0), w - 1);
          const x = values[jj * w + i2]!;
          if (isH ? x > bv : x < bv) { bv = x; bi = i2; bj = jj; }
        }
      }
      const type = isH ? 'H' : 'L';
      if (near(bi, bj, type)) continue;
      found.push({ type, value: bv, lon: d.lon_left + bi * dx, lat: d.lat_top - bj * dy, i: bi, j: bj });
    }
  }
  return found.map(({ type, value, lon, lat }) => ({ type, value, lon: wrap180(lon), lat }));
}

/** Catmull-Rom weights for the 4 taps around a point at fraction t in [0,1) between taps 1 and 2. */
function cr(t: number): [number, number, number, number] {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

/**
 * Interpolate a field to `n` times the resolution with a separable Catmull-Rom cubic. Global longitude grids wrap
 * (the result keeps the "last column is one step before the first" layout); latitude rows clamp at the edges.
 * Catmull-Rom passes through the original samples exactly, so the data are never altered, only filled in.
 */
export function upsampleScalar(d: DecodedScalar, n: number): DecodedScalar {
  n = Math.floor(n);
  if (!(n > 1)) return d;
  const { width: w, height: h, values } = d;
  const periodic = isGlobalLon(d);
  const w2 = periodic ? w * n : (w - 1) * n + 1;
  const h2 = (h - 1) * n + 1;
  const xi = (i: number) => (periodic ? ((i % w) + w) % w : Math.min(Math.max(i, 0), w - 1));
  const yi = (j: number) => Math.min(Math.max(j, 0), h - 1);
  const wts = Array.from({ length: n }, (_, k) => cr(k / n));
  // pass 1: along longitude, original rows -> w2 columns
  const tmp = new Float32Array(w2 * h);
  for (let j = 0; j < h; j++) {
    const row = j * w;
    for (let I = 0; I < w2; I++) {
      const i = Math.floor(I / n), k = I - i * n, c = wts[k]!;
      tmp[j * w2 + I] =
        c[0] * values[row + xi(i - 1)]! + c[1] * values[row + xi(i)]! + c[2] * values[row + xi(i + 1)]! + c[3] * values[row + xi(i + 2)]!;
    }
  }
  // pass 2: along latitude, h rows -> h2 rows
  const out = new Float32Array(w2 * h2);
  for (let J = 0; J < h2; J++) {
    const j = Math.floor(J / n), k = J - j * n, c = wts[k]!;
    const r0 = yi(j - 1) * w2, r1 = yi(j) * w2, r2 = yi(j + 1) * w2, r3 = yi(j + 2) * w2;
    for (let I = 0; I < w2; I++) out[J * w2 + I] = c[0] * tmp[r0 + I]! + c[1] * tmp[r1 + I]! + c[2] * tmp[r2 + I]! + c[3] * tmp[r3 + I]!;
  }
  const dx = (d.lon_right - d.lon_left) / (w - 1);
  return { ...d, width: w2, height: h2, values: out, lon_right: d.lon_left + (w2 - 1) * (dx / n) };
}

/**
 * Isobars (contour lines + label anchors + H/L centres) of a decoded field. Pure and synchronous: run it in a worker.
 * Lines use lon/lat in [-180,180]; features crossing the antimeridian are `MultiLineString`s split at +-180.
 */
export function buildIsobarSet(d: DecodedScalar, opts: IsobarOptions = {}): IsobarResult {
  if ((opts.upsample ?? 1) > 1) d = upsampleScalar(d, Math.min(Math.floor(opts.upsample!), 4));
  const interval = opts.interval ?? 4;
  const base = opts.base ?? 1000;
  const smooth = Math.max(0, Math.floor(opts.smooth ?? 0));
  const majorEvery = opts.majorEvery ?? 5;
  const spacing = opts.labelSpacing ?? 14;
  const minLabel = opts.minLabelLength ?? 5;
  const decimals = opts.decimals ?? 0;
  if (!(interval > 0)) throw new Error('scalar-layer: isobar interval must be > 0');
  const { width: w, height: h, values } = d;
  const periodic = isGlobalLon(d);
  const dx = (d.lon_right - d.lon_left) / (w - 1);
  const dy = (d.lat_top - d.lat_bottom) / (h - 1);

  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const lines: IsobarResult['lines']['features'] = [];
  const labels: IsobarResult['labels']['features'] = [];
  if (mn <= mx) {
    const k0 = Math.ceil((mn - base) / interval);
    const k1 = Math.floor((mx - base) / interval);
    const levelOf = (k: number) => Math.round((base + k * interval) * 1e6) / 1e6;
    const all = contourAll(values, w, h, periodic, base, interval, k0, k1, levelOf);
    for (let k = k0; k <= k1; k++) {
      const value = levelOf(k);
      const major = k % majorEvery === 0;
      for (const ch of all.get(k) ?? []) {
        if (ch.pts.length < 2) continue;
        const pts = chaikin(ch.pts, ch.closed, smooth).map(([fx, fy]): Pt => [d.lon_left + fx * dx, d.lat_top - fy * dy]);
        const parts = splitAtAntimeridian(pts, ch.closed);
        if (!parts.length) continue;
        const r = (n: number) => Math.round(n * 1e4) / 1e4;
        const coords = parts.map((p) => p.map(([x, y]): Pt => [r(x), r(y)]));
        lines.push({
          type: 'Feature',
          properties: { value, major },
          geometry: coords.length === 1 ? { type: 'LineString', coordinates: coords[0]! } : { type: 'MultiLineString', coordinates: coords },
        });
        // labels: along each part, every `spacing` degrees of arc, phase offset by the level so labels do not line up
        const text = value.toFixed(decimals);
        for (const p of parts) {
          let total = 0;
          for (let i = 1; i < p.length; i++) total += arcLen(p[i - 1]!, p[i]!);
          if (total < minLabel) continue;
          const n = Math.max(1, Math.floor(total / spacing));
          const phase = (((k % 7) + 7) % 7) / 7;
          let target = (spacing * (0.5 + 0.4 * phase));
          if (n === 1) target = total / 2;
          let acc = 0;
          for (let i = 1; i < p.length && target < total; i++) {
            const seg = arcLen(p[i - 1]!, p[i]!);
            while (acc + seg >= target && target < total) {
              const t = seg > 0 ? (target - acc) / seg : 0;
              const a = p[i - 1]!, b = p[i]!;
              const lon = a[0] + (b[0] - a[0]) * t;
              const lat = a[1] + (b[1] - a[1]) * t;
              if (Math.abs(lat) < 85 && Math.abs(lon) < 179.5)
                labels.push({ type: 'Feature', properties: { value, text, angle: textAngle(a, b), major }, geometry: { type: 'Point', coordinates: [r(lon), r(lat)] } });
              target += spacing;
            }
            acc += seg;
          }
        }
      }
    }
  }
  const centres = extrema(d, opts.extremaRadius ?? 10, opts.extremaMinDelta ?? interval).map(
    (e): IsobarResult['centres']['features'][number] => ({
      type: 'Feature',
      properties: { type: e.type, value: Math.round(e.value * 10) / 10 },
      geometry: { type: 'Point', coordinates: [Math.round(e.lon * 1e4) / 1e4, e.lat] },
    }),
  );
  return {
    lines: { type: 'FeatureCollection', features: lines },
    labels: { type: 'FeatureCollection', features: labels },
    centres: { type: 'FeatureCollection', features: centres },
  };
}

/** Isobar lines only (GeoJSON LineStrings with `{ value }`). Pure; safe in a Web Worker. */
export function buildIsobars(d: DecodedScalar, opts: IsobarOptions = {}): IsobarResult['lines'] {
  return buildIsobarSet(d, opts).lines;
}
