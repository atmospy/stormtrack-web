// Generates a small, contract-compliant sample data set under public-data/sample/.
// Usage: pnpm --filter web sample
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public-data/sample');
const write = (rel, data) => {
  const p = resolve(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
const json = (rel, obj) => write(rel, JSON.stringify(obj));

// ---------- deterministic rng ----------
let seed = 20261101;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ---------- wind ----------
const W = 720, H = 361;
const RUN = '2026-11-01T00:00:00Z';
const RUN_KEY = '20261101T00';
const RANGE = 50, SPEED_MAX = 70;
const deg = Math.PI / 180;

function windAt(lon, lat, fhr) {
  // zonal-mean background: trades (easterly), midlat westerlies, polar easterlies
  const a = lat * deg;
  let u = -7 * Math.cos(3 * a) * Math.cos(a) * 1.2 + 4 * Math.sin(a * 2) * Math.sin(a * 2) * Math.sign(Math.sin(a) || 1) * 0;
  u = -6.5 * Math.cos(3 * a) + 2.0 * Math.cos(a);
  let v = 3.2 * Math.sin(lon * deg * 3 + lat * deg * 2 + fhr * 0.05) * Math.cos(a);
  u += 2.5 * Math.sin(lon * deg * 2 - lat * deg * 3) * Math.cos(a);
  // Rankine-like vortices: [lon0, lat0, vmax, rmax(km), drift lon/lat per 24h]
  const vort = [
    [88.5, 14.0, 42, 55, -1.6, 2.0, +1],
    [138.0, 17.0, 33, 90, -2.5, 1.5, +1],
    [-42.0, -28.0, 22, 160, 6, -1, -1]
  ];
  for (const [lo, la, vmax, rmaxKm, dlo, dla, hem] of vort) {
    const lo0 = lo + (dlo * fhr) / 24, la0 = la + (dla * fhr) / 24;
    const dx = (lon - lo0) * deg * Math.cos(la0 * deg) * 6371;
    const dy = (lat - la0) * deg * 6371;
    const r = Math.hypot(dx, dy) + 1e-6;
    const vt = r < rmaxKm ? (vmax * r) / rmaxKm : vmax * Math.pow(rmaxKm / r, 0.6) * Math.exp(-Math.max(0, r - 600) / 900);
    // cyclonic: counter-clockwise in NH (hem=+1), clockwise in SH; add inflow
    const tx = (-dy / r) * hem, ty = (dx / r) * hem;
    const ix = -dx / r, iy = -dy / r;
    u += vt * (tx * 0.92 + ix * 0.38);
    v += vt * (ty * 0.92 + iy * 0.38);
  }
  return [u, v];
}

const frames = [];
for (let fhr = 0; fhr <= 48; fhr += 6) {
  const png = new PNG({ width: W, height: H, colorType: 6 });
  for (let y = 0; y < H; y++) {
    const lat = 90 - (y * 180) / (H - 1);
    for (let x = 0; x < W; x++) {
      const lon = -180 + (x * 359.5) / (W - 1);
      const [u, v] = windAt(lon, lat, fhr);
      const sp = Math.hypot(u, v);
      const i = (y * W + x) * 4;
      png.data[i] = Math.round(((Math.max(-RANGE, Math.min(RANGE, u)) + RANGE) / (2 * RANGE)) * 255);
      png.data[i + 1] = Math.round(((Math.max(-RANGE, Math.min(RANGE, v)) + RANGE) / (2 * RANGE)) * 255);
      png.data[i + 2] = Math.round((Math.min(sp, SPEED_MAX) / SPEED_MAX) * 255);
      png.data[i + 3] = 255;
    }
  }
  const buf = PNG.sync.write(png, { colorType: 6, filterType: -1, deflateLevel: 9 });
  const rel = `wind/${RUN_KEY}/f${String(fhr).padStart(3, '0')}.png`;
  write(rel, buf);
  const valid = new Date(Date.parse(RUN) + fhr * 3600e3).toISOString().replace('.000Z', 'Z');
  frames.push({ fhr, valid, png: rel, bytes: buf.length });
}
json('wind/latest.json', {
  schema: 1,
  source: 'SAMPLE (synthetic) wind field',
  licence: 'Synthetic data for development only',
  level: '10m',
  units: 'm/s',
  run: RUN,
  generated: '2026-11-01T05:00:00Z',
  image: {
    width: W, height: H, lon_left: -180, lon_right: 179.5, lat_top: 90, lat_bottom: -90,
    u: { min: -RANGE, max: RANGE }, v: { min: -RANGE, max: RANGE }, speed_max: SPEED_MAX
  },
  frames
});

// ---------- storms ----------
const iso = (h) => new Date(Date.parse(RUN) + h * 3600e3).toISOString().replace('.000Z', 'Z');
const ssLabel = (kt) => (kt < 34 ? 'TD' : kt < 64 ? 'TS' : kt < 83 ? 'C1' : kt < 96 ? 'C2' : kt < 113 ? 'C3' : kt < 137 ? 'C4' : 'C5');

function activeStorm({ id, name, basin, agency, track, fc, tech }) {
  const last = track[track.length - 1];
  const feats = [];
  feats.push({
    type: 'Feature', geometry: { type: 'Point', coordinates: [last.lon, last.lat] },
    properties: {
      kind: 'position', id, name, basin, agency, time: last.t, wind_kt: last.w, pressure_hpa: last.p,
      category: { scale: 'saffir-simpson', label: ssLabel(last.w) }, heading_deg: last.hd, speed_kmh: last.sp, wind_period_min: 1
    }
  });
  feats.push({
    type: 'Feature', geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) },
    properties: { kind: 'track', id, times: track.map((p) => p.t), wind_kt: track.map((p) => p.w) }
  });
  const fpts = [{ lon: last.lon, lat: last.lat, tau: 0, w: last.w }, ...fc];
  feats.push({
    type: 'Feature', geometry: { type: 'LineString', coordinates: fpts.map((p) => [p.lon, p.lat]) },
    properties: { kind: 'forecast', id, init: last.t, tech, taus: fpts.map((p) => p.tau), wind_kt: fpts.map((p) => p.w), category: fpts.map((p) => ssLabel(p.w)) }
  });
  // cone: buffer along the forecast line with growing radius
  const radii = fpts.map((p) => 30 + p.tau * 4.2);
  const left = [], right = [];
  for (let i = 0; i < fpts.length; i++) {
    const a = fpts[Math.max(0, i - 1)], b = fpts[Math.min(fpts.length - 1, i + 1)];
    const brg = Math.atan2((b.lon - a.lon) * Math.cos(fpts[i].lat * deg), b.lat - a.lat);
    const rdeg = radii[i] / 111;
    const off = (s) => [fpts[i].lon + (s * rdeg * Math.cos(brg)) / Math.cos(fpts[i].lat * deg), fpts[i].lat - s * rdeg * Math.sin(brg)];
    left.push(off(1)); right.push(off(-1));
  }
  const endp = fpts[fpts.length - 1], cap = [];
  const brgEnd = Math.atan2((endp.lon - fpts[fpts.length - 2].lon), endp.lat - fpts[fpts.length - 2].lat);
  for (let k = 1; k < 12; k++) {
    const ang = brgEnd + Math.PI / 2 - (k * Math.PI) / 12;
    const rd = radii[radii.length - 1] / 111;
    cap.push([endp.lon + (rd * Math.sin(ang)) / Math.cos(endp.lat * deg), endp.lat + rd * Math.cos(ang)]);
  }
  const ring = [...left, ...cap, ...right.reverse()];
  ring.push(ring[0]);
  feats.push({
    type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { kind: 'cone', id, radii_km: radii.map((r) => Math.round(r)), basis: 'SAMPLE: synthetic 67% circles (30 km + 4.2 km/h), not an official cone' }
  });
  return feats;
}

const mk = (lon, lat, h, w, p, hd, sp) => ({ lon, lat, t: iso(h), w, p, hd, sp });
const s1 = activeStorm({
  id: 'IO042026', name: 'SAMPLE', basin: 'NI', agency: 'JTWC', tech: 'JTWC',
  track: [mk(92.5, 9.5, -48, 30, 1004, 300, 14), mk(91.4, 10.6, -36, 38, 999, 305, 15), mk(90.4, 11.7, -24, 50, 992, 310, 16),
    mk(89.5, 12.8, -12, 64, 985, 315, 17), mk(88.5, 14.0, 0, 80, 975, 330, 18)],
  fc: [{ lon: 87.9, lat: 15.5, tau: 12, w: 95 }, { lon: 87.5, lat: 17.1, tau: 24, w: 110 }, { lon: 87.3, lat: 19.0, tau: 36, w: 100 },
    { lon: 87.6, lat: 21.0, tau: 48, w: 70 }, { lon: 88.4, lat: 23.0, tau: 72, w: 40 }]
});
const s2 = activeStorm({
  id: 'WP182026', name: 'SAMPLE-TWO', basin: 'WP', agency: 'JTWC', tech: 'JTWC',
  track: [mk(144.0, 12.0, -48, 25, 1006, 285, 20), mk(142.0, 13.2, -36, 35, 1000, 290, 22), mk(140.0, 14.4, -24, 45, 994, 295, 21),
    mk(139.0, 15.5, -12, 55, 990, 300, 20), mk(138.0, 17.0, 0, 65, 985, 310, 19)],
  fc: [{ lon: 136.8, lat: 18.6, tau: 12, w: 80 }, { lon: 135.8, lat: 20.3, tau: 24, w: 100 }, { lon: 135.2, lat: 22.2, tau: 48, w: 120 }, { lon: 135.5, lat: 25.0, tau: 72, w: 110 }]
});
json('storms/active.geojson', { type: 'FeatureCollection', features: [...s1, ...s2] });

// history (approximate, simplified from memory; sample only)
const hist = [
  ['1999-OR', '1999 super cyclone', 1999, 140, [[94.5, 12.5], [91, 14], [88.5, 15.5], [86.8, 17], [86.2, 19], [85.7, 20], [85.0, 21], [84.0, 22.5]], '1999-10-25', '1999-11-03'],
  ['2007-GONU', 'GONU', 2007, 135, [[68.5, 12], [66, 14.5], [63.5, 17], [61.5, 20], [59.8, 22.2], [58.5, 23.5]], '2007-06-02', '2007-06-07'],
  ['2008-NARGIS', 'NARGIS', 2008, 115, [[85, 12.5], [88, 14], [91.5, 15], [94, 16], [95.6, 16.5], [96.5, 17.5]], '2008-04-27', '2008-05-03'],
  ['2013-PHAILIN', 'PHAILIN', 2013, 120, [[97.5, 10.5], [94, 12.5], [90.5, 14.5], [87.5, 16.5], [85.7, 19], [85.2, 20.8], [84.6, 22.5], [83.5, 24]], '2013-10-08', '2013-10-14'],
  ['2019-FANI', 'FANI', 2019, 115, [[87.5, 5], [85.5, 8.5], [84.4, 12], [84.8, 15.5], [85.5, 18.5], [86.2, 20.5], [87.2, 22.2], [89.3, 24.5]], '2019-04-26', '2019-05-04'],
  ['2020-AMPHAN', 'AMPHAN', 2020, 140, [[86.2, 9.5], [86.4, 11.8], [86.9, 14.5], [87.4, 17.5], [87.9, 20], [88.7, 21.7], [89.5, 23.2]], '2020-05-16', '2020-05-21'],
  ['2021-TAUKTAE', 'TAUKTAE', 2021, 100, [[72.5, 11.5], [72.8, 14], [72.5, 17], [71.6, 19.8], [70.6, 21.0], [71.5, 22.5], [72.8, 24.5]], '2021-05-14', '2021-05-19'],
  ['2021-YAAS', 'YAAS', 2021, 75, [[88.4, 15.2], [88.0, 17.2], [87.6, 19.4], [87.0, 20.8], [86.4, 21.6], [85.9, 22.8]], '2021-05-23', '2021-05-28'],
  ['2023-BIPARJOY', 'BIPARJOY', 2023, 110, [[67.5, 11], [66.8, 14], [66.3, 17], [66.5, 20.5], [67.5, 22.5], [69, 23.7]], '2023-06-05', '2023-06-17'],
  ['2023-MICHAUNG', 'MICHAUNG', 2023, 80, [[85.5, 10.5], [84.2, 12.5], [81.8, 13.5], [81.0, 14.8], [80.6, 15.9]], '2023-12-01', '2023-12-06'],
  ['2022-MANDOUS', 'MANDOUS', 2022, 65, [[88.5, 8.4], [85.5, 9.2], [83, 10.2], [80.5, 11.4], [79.0, 12.3]], '2022-12-06', '2022-12-10'],
  ['2018-GAJA', 'GAJA', 2018, 80, [[89.2, 12.3], [86.0, 11.8], [82.6, 11.2], [79.6, 10.5]], '2018-11-10', '2018-11-16']
];
const catOf = (kt) => (kt < 34 ? 'TD' : kt < 64 ? 'TS' : kt < 83 ? 'C1' : kt < 96 ? 'C2' : kt < 113 ? 'C3' : kt < 137 ? 'C4' : 'C5');
const grade = (kt) => (kt < 34 ? 'D' : kt < 64 ? 'CS' : kt < 90 ? 'SCS' : kt < 120 ? 'VSCS' : kt < 140 ? 'ESCS' : 'SuCS');
json('storms/history/NI.geojson', {
  type: 'FeatureCollection',
  features: hist.map(([id, name, year, kt, coords, start, end]) => ({
    type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { id, name, year, max_wind_kt: kt, category: catOf(kt), imd_grade: grade(kt), start, end }
  }))
});

const annual = [];
for (let y = 1990; y <= 2025; y++) {
  const storms = 3 + Math.floor(rnd() * 6);
  const ts = Math.max(1, Math.round(storms * (0.55 + rnd() * 0.2)));
  const hu = Math.min(ts, Math.round(storms * (0.2 + rnd() * 0.25)));
  annual.push({ year: y, storms, tropical_storm: ts, hurricane: hu, major: Math.min(hu, Math.round(rnd() * 2)), ace: Math.round((storms * (4 + rnd() * 8)) * 10) / 10 });
}
const monthly = [0.05, 0.02, 0.05, 0.25, 0.7, 0.55, 0.12, 0.1, 0.2, 0.9, 1.2, 0.5].map((v, i) => ({ month: i + 1, storms_per_year: v }));
json('storms/stats/NI.json', {
  annual, monthly,
  rapid_intensification: [{ id: '2020-AMPHAN', name: 'AMPHAN', year: 2020, max_dwind_kt_24h: 65 }],
  lifetime_max: [{ id: '1999-OR', name: '1999 super cyclone', year: 1999, wind_kt: 140, lat: 19, lon: 87 }],
  notes: 'SAMPLE (synthetic) statistics for development. Real statistics note agency wind averaging (IMD 3-min vs NHC/JTWC 1-min) and the satellite-era cut-off.'
});
// (storms/index.json is written after the multi-basin history below)

// ---------- storms: multi-basin history + stats (synthetic; one file per basin, CONTRACTS section 2) ----------
// Genesis box [lon0, lon1, lat0, lat1], steering (dlon, dlat per step before/after recurvature), hemisphere, active months, names.
const BASINS = {
  NA: { box: [-60, -20, 10, 20], mv: [-1.6, 0.55], re: [1.6, 1.6], months: [6, 7, 8, 9, 10, 11], names: ['ARLENE', 'BRET', 'CINDY', 'DON', 'EMILY', 'FRANKLIN', 'GERT', 'HARVEY', 'IRMA', 'JOSE', 'KATIA', 'LEE'] },
  EP: { box: [-120, -95, 9, 17], mv: [-1.7, 0.4], re: [0.4, 1.1], months: [6, 7, 8, 9, 10], names: ['ADRIAN', 'BEATRIZ', 'CALVIN', 'DORA', 'EUGENE', 'FERNANDA', 'GREG', 'HILARY', 'IRWIN', 'JOVA'] },
  WP: { box: [125, 160, 7, 17], mv: [-1.9, 0.7], re: [2.2, 1.7], months: [6, 7, 8, 9, 10, 11, 12], names: ['HAIYAN', 'MEGI', 'SONGDA', 'RAI', 'LEKIMA', 'HAGIBIS', 'MANGKHUT', 'NARI', 'KROSA', 'TALIM', 'DOKSURI'] },
  NI: { box: [80, 94, 8, 15], mv: [-0.6, 1.0], re: [0.3, 1.2], months: [4, 5, 10, 11, 12], names: ['AILA', 'KYARR', 'HUDHUD', 'VARDAH', 'OCKHI', 'TITLI', 'GAJA', 'FANI', 'BULBUL', 'AMPHAN', 'NIVAR'] },
  SI: { box: [55, 95, -17, -8], mv: [-1.3, -0.5], re: [1.2, -1.4], months: [12, 1, 2, 3, 4], names: ['FREDDY', 'IDAI', 'KENNETH', 'BATSIRAI', 'GAMEDE', 'HARUNA', 'DUMAZILE', 'ENAWO'] },
  SP: { box: [150, 175, -18, -9], mv: [1.0, -0.8], re: [1.7, -1.5], months: [12, 1, 2, 3, 4], names: ['WINSTON', 'GITA', 'PAM', 'YASI', 'HAROLD', 'JUDY', 'KEVIN', 'LUCAS'] },
  SA: { box: [-45, -30, -30, -22], mv: [0.8, -0.3], re: [1.2, -0.8], months: [3, 4, 12, 1, 2], names: ['CATARINA', 'ANITA', 'ARANI', 'IBA', 'KURUMI'] }
};
const BASIN_NAMES = { NA: 'North Atlantic', EP: 'East Pacific', WP: 'West Pacific', NI: 'North Indian', SI: 'South Indian', SP: 'South Pacific', SA: 'South Atlantic' };
const hist2 = {};
const statsOf = {};
const SEED_BASIN = { NA: 11, EP: 12, WP: 13, NI: 14, SI: 15, SP: 16, SA: 17 };
const winds = (n, peak) => Array.from({ length: n }, (_, i) => { const x = i / (n - 1); return Math.round(25 + (peak - 25) * Math.sin(Math.PI * Math.min(1, x * 1.15)) ** 1.2); });
for (const [code, b] of Object.entries(BASINS)) {
  seed = 777 * SEED_BASIN[code];
  const nStorms = code === 'NI' ? 0 : code === 'SA' ? 14 : code === 'WP' ? 160 : 90;
  const feats = [];
  for (let i = 0; i < nStorms; i++) {
    const year = 1980 + Math.floor(rnd() * 46);
    const peak = Math.round(35 + Math.pow(rnd(), 1.8) * 120);
    const steps = 14 + Math.floor(rnd() * 14);
    let lon = b.box[0] + rnd() * (b.box[1] - b.box[0]);
    let lat = b.box[2] + rnd() * (b.box[3] - b.box[2]);
    const hem = lat >= 0 ? 1 : -1;
    const recurve = 5 + Math.floor(rnd() * (steps - 8));
    const coords = [[Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]];
    for (let k = 1; k < steps; k++) {
      const t = Math.min(1, Math.max(0, (k - recurve + 3) / 6));
      lon += (b.mv[0] * (1 - t) + b.re[0] * t) * (0.7 + rnd() * 0.6);
      lat += (b.mv[1] * (1 - t) + b.re[1] * t) * (0.7 + rnd() * 0.6) * (hem < 0 && b.mv[1] > 0 ? -1 : 1);
      if (Math.abs(lon) > 179.5) break; // sample tracks stop at the antimeridian (real data splits into MultiLineString)
      coords.push([Math.round(lon * 100) / 100, Math.round(lat * 100) / 100]);
    }
    // split at the antimeridian is skipped on purpose: sample tracks are clamped to stay on one side
    const mon = b.months[Math.floor(rnd() * b.months.length)];
    const day = 1 + Math.floor(rnd() * 24);
    const start = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const end = `${year}-${String(mon).padStart(2, '0')}-${String(Math.min(28, day + Math.floor(steps / 4))).padStart(2, '0')}`;
    const name = rnd() < 0.15 ? null : b.names[Math.floor(rnd() * b.names.length)];
    feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { id: `${year}-${code}${String(i).padStart(3, '0')}`, name, year, max_wind_kt: peak, category: catOf(peak), imd_grade: code === 'NI' ? grade(peak) : null, start, end } });
  }
  hist2[code] = feats;
}
// NI keeps the hand-written storms from above (real names/approximate tracks)
hist2.NI = hist.map(([id, name, year, kt, coords, start, end]) => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
  properties: { id, name, year, max_wind_kt: kt, category: catOf(kt), imd_grade: grade(kt), start, end }
}));
const indexHistory = {};
const indexList = [];
for (const [code, feats] of Object.entries(hist2)) {
  for (const f of feats) f.properties.basin = code;
  const histJson = JSON.stringify({ type: 'FeatureCollection', features: feats });
  write(`storms/history/${code}.geojson`, histJson);
  const years = feats.map((f) => f.properties.year);
  indexHistory[code] = { name: BASIN_NAMES[code], count: feats.length, year_min: Math.min(...years), year_max: Math.max(...years), sources: ['SAMPLE'], file: `storms/history/${code}.geojson`, stats: `storms/stats/${code}.json`, bytes: histJson.length, gzip_bytes: gzipSync(histJson).length };
  indexList.push({ id: code, ...indexHistory[code] });
  seed = 31 * SEED_BASIN[code];
  const annual = [];
  for (let y = 1990; y <= 2025; y++) {
    const storms = 3 + Math.floor(rnd() * (code === 'WP' ? 20 : 8));
    const ts = Math.max(1, Math.round(storms * (0.55 + rnd() * 0.2)));
    const hu = Math.min(ts, Math.round(storms * (0.2 + rnd() * 0.25)));
    annual.push({ year: y, storms, tropical_storm: ts, hurricane: hu, major: Math.min(hu, Math.round(rnd() * 2)), ace: Math.round(storms * (4 + rnd() * 8) * 10) / 10 });
  }
  const monthly = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, storms_per_year: BASINS[code].months.includes(i + 1) ? Math.round((0.3 + rnd() * 1.6) * 100) / 100 : 0.02 }));
  const top = [...feats].sort((a, b) => b.properties.max_wind_kt - a.properties.max_wind_kt)[0];
  statsOf[code] = {
    annual, monthly,
    rapid_intensification: [{ id: top.properties.id, name: top.properties.name ?? top.properties.id, year: top.properties.year, max_dwind_kt_24h: 55 }],
    lifetime_max: [{ id: top.properties.id, name: top.properties.name ?? top.properties.id, year: top.properties.year, wind_kt: top.properties.max_wind_kt, lat: top.geometry.coordinates[3][1], lon: top.geometry.coordinates[3][0] }],
    basin: code, name: BASIN_NAMES[code], monthly_period: [1980, 2025],
    notes: `SAMPLE (synthetic) ${code} statistics for development. Real statistics note agency wind averaging and the satellite-era cut-off.`
  };
  json(`storms/stats/${code}.json`, statsOf[code]);
}
json('storms/history/all-index.json', { schema: 1, generated: '2026-11-01T05:00:00Z', basins: indexList, total_bytes: indexList.reduce((a, b) => a + b.bytes, 0), total_gzip_bytes: indexList.reduce((a, b) => a + b.gzip_bytes, 0) });
json('storms/index.json', {
  schema: 1, generated: '2026-11-01T05:00:00Z',
  active: { count: 2, updated: iso(0), sources: ['JTWC'] },
  history: indexHistory
});

// ---------- weather v2: two small models on a coarse 2 degree grid (sample only; the contract is resolution-agnostic) ----------
const GW = 180, GH = 91, GRID = { width: GW, height: GH, lon_left: -180, lon_right: -180 + (GW - 1) * 2, lat_top: 90, lat_bottom: -90 };
const WX_RUN = '2026-11-01T00:00:00Z';
const WX_KEY = '20261101T00';
const WX_FHRS = [0, 12, 24, 36];
const lonAt = (x) => -180 + x * 2;
const latAt = (y) => 90 - y * 2;
const gauss = (d, r) => Math.exp(-((d / r) ** 2));
// shared cyclone centres (match the windAt vortices) as [lon, lat, drift lon, drift lat per 24 h]
const LOWS = [[88.5, 14.0, -1.6, 2.0], [138.0, 17.0, -2.5, 1.5], [-42.0, -28.0, 6, -1]];
const kmTo = (lo, la, lo0, la0) => Math.hypot((lo - lo0) * Math.cos(la0 * deg) * 111, (la - la0) * 111);
function mslpAt(lon, lat, fhr, model) {
  const a = lat * deg;
  let p = 1013 + 9 * Math.cos(2 * (Math.abs(lat) - 32) * deg) * Math.cos(a) - 8 * gauss(lat, 12) + 4 * Math.sin((lon + (model === 'ecmwf-ifs' ? 18 : 0)) * deg * 3 + fhr * 0.04) * Math.cos(a) ** 2;
  for (const [lo, la, dlo, dla] of LOWS) p -= 52 * gauss(kmTo(lon, lat, lo + (dlo * fhr) / 24, la + (dla * fhr) / 24), 650);
  return p;
}
function t2mAt(lon, lat, fhr, model) {
  const sun = Math.cos(((lon + fhr * 15) % 360) * deg);
  return 30 * Math.cos(lat * deg) - 12 + 7 * sun * Math.cos(lat * deg) + (model === 'ecmwf-ifs' ? 0.8 : 0) - 0.006 * Math.abs(lat) ** 1.5 * 0;
}
function precipAt(lon, lat, fhr, model) {
  if (fhr === 0) return 0;
  let r = 14 * gauss(lat - 6, 7) * (0.6 + 0.4 * Math.sin(lon * deg * 4 + fhr * 0.2)) ** 2;
  for (const [lo, la, dlo, dla] of LOWS) r += 55 * gauss(kmTo(lon, lat, lo + (dlo * fhr) / 24, la + (dla * fhr) / 24), 420);
  return Math.max(0, r * (model === 'ecmwf-ifs' ? 0.85 : 1));
}
const LEVEL_SCALE = { '10m': 1, 850: 1.35, 700: 1.7, 500: 2.2, 300: 3.3, 250: 3.6 };
function windLvl(lon, lat, fhr, lvl) {
  const [u, v] = windAt(lon, lat, fhr);
  const s = LEVEL_SCALE[lvl];
  // add a mid-latitude jet aloft
  const jet = lvl === '10m' || lvl === '850' ? 0 : (lvl === '250' ? 38 : 20) * gauss(Math.abs(lat) - 38, 10);
  return [u * s + jet, v * s];
}
function writePng(rel, w, h, fn) {
  const png = new PNG({ width: w, height: h, colorType: 6 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); const i = (y * w + x) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; }
  const buf = PNG.sync.write(png, { colorType: 6, filterType: -1, deflateLevel: 9 });
  write(rel, buf);
  return buf.length;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function windField(model, lvl) {
  const R = LEVEL_SCALE[lvl] > 2.5 ? 100 : 50, SM = LEVEL_SCALE[lvl] > 2.5 ? 140 : 70;
  const slug = lvl === '10m' ? 'wind_10m' : `wind_${lvl}`;
  const frames = WX_FHRS.map((fhr) => {
    const rel = `weather/${model}/${WX_KEY}/${slug}/f${String(fhr).padStart(3, '0')}.png`;
    const bytes = writePng(rel, GW, GH, (x, y) => {
      const [u, v] = windLvl(lonAt(x), latAt(y), fhr + (model === 'ecmwf-ifs' ? 1.5 : 0), lvl);
      return [Math.round(((clamp(u, -R, R) + R) / (2 * R)) * 255), Math.round(((clamp(v, -R, R) + R) / (2 * R)) * 255), Math.round((Math.min(Math.hypot(u, v), SM) / SM) * 255)];
    });
    return { fhr, valid: iso(fhr), png: rel, bytes };
  });
  return { id: `wind@${lvl === '10m' ? '10m' : lvl + 'hPa'}`, slug, kind: 'vector', units: 'm/s', level: lvl === '10m' ? { type: 'height_agl', value: 10, label: '10 m' } : { type: 'pressure', value: +lvl, label: `${lvl} hPa` }, range: { u: [-R, R], v: [-R, R], speed_max: SM }, frames };
}
function scalarFieldOut(model, id, slug, units, range, fn, transform) {
  const [lo, hi] = transform === 'sqrt' ? [Math.sqrt(range[0]), Math.sqrt(range[1])] : range;
  const frames = WX_FHRS.map((fhr) => {
    const rel = `weather/${model}/${WX_KEY}/${slug}/f${String(fhr).padStart(3, '0')}.png`;
    const bytes = writePng(rel, GW, GH, (x, y) => {
      let val = fn(lonAt(x), latAt(y), fhr, model);
      if (transform === 'sqrt') val = Math.sqrt(Math.max(0, val));
      const v16 = Math.round(clamp((val - lo) / (hi - lo), 0, 1) * 65535);
      return [v16 >> 8, v16 & 255, 0];
    });
    return { fhr, valid: iso(fhr), png: rel, bytes };
  });
  return { id, slug, kind: 'scalar', units, range, ...(transform ? { transform } : {}), frames };
}
const MODELS = [
  { id: 'gfs', name: 'NOAA GFS (SAMPLE)', licence: 'Synthetic data for development only', levels: ['10m', '850', '500', '250'], scalars: ['mslp', 't2m', 'precip'] },
  { id: 'ecmwf-ifs', name: 'ECMWF IFS (SAMPLE)', licence: 'Synthetic data for development only', levels: ['10m', '850'], scalars: ['mslp', 't2m'] }
];
const catalogue = [];
for (const m of MODELS) {
  const fields = m.levels.map((l) => windField(m.id, l));
  if (m.scalars.includes('mslp')) fields.push(scalarFieldOut(m.id, 'mslp', 'mslp', 'hPa', [930, 1070], mslpAt));
  if (m.scalars.includes('t2m')) fields.push(scalarFieldOut(m.id, 't2m', 't2m', '°C', [-60, 60], t2mAt));
  if (m.scalars.includes('precip')) fields.push(scalarFieldOut(m.id, 'precip', 'precip', 'mm per frame interval', [0, 100], precipAt, 'sqrt'));
  json(`weather/${m.id}/latest.json`, { schema: 2, model: m.id, name: m.name, licence: m.licence, run: WX_RUN, generated: '2026-11-01T05:00:00Z', grid: GRID, fields });
  catalogue.push({ id: m.id, name: m.name, licence: m.licence, run: WX_RUN, latest: `weather/${m.id}/latest.json` });
}
json('weather/index.json', { schema: 2, generated: '2026-11-01T05:00:00Z', models: catalogue });

// ---------- lightning (CONTRACTS section 6 / 6.1): two sources, fixtures for the multi-source form ----------
{
  seed = 4242;
  const T0 = '2026-11-01T19:00:00Z', UPD = '2026-11-01T19:59:30Z';
  // [lon, lat, spread, n, src]; src 0 = GOES GLM (exact times), src 1 = an unofficial regional feed over India (bucketed times)
  const cells = [[-90, 28, 5, 2200, 0], [-62, -24, 6, 1800, 0], [-75, 5, 4, 1600, 0], [-100, 36, 3, 900, 0], [-48, 0, 7, 700, 0], [-122, 30, 5, 250, 0], [-35, 15, 4, 400, 0],
    [85, 22, 3, 700, 1], [78, 14, 3, 500, 1], [92, 26, 2, 300, 1]];
  const rows = [];
  for (const [clo, cla, sp, n, src] of cells) {
    for (let i = 0; i < n; i++) {
      const g = () => (rnd() + rnd() + rnd() - 1.5) * sp;
      let dt = Math.floor(Math.pow(rnd(), 0.8) * 3590);
      if (src === 1) dt = Math.floor(dt / 300) * 300; // bucketed to 5 min
      const dp = src === 1 ? 10000 : 100; // 4 dp for the regional source, 2 dp for GLM
      rows.push([dt, Math.round((clo + g() + dt / 3600) * dp) / dp, Math.round((cla + g() * 0.8) * dp) / dp, src === 1 ? null : Math.round(Math.pow(rnd(), 2) * 900 * 10) / 10, src]);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  json('lightning/flashes.json', { schema: 1, t0: T0, cols: ['dt_s', 'lon', 'lat', 'energy_fj', 'src'], rows });
  json('lightning/coverage.geojson', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { source: 'goes-glm', name: 'GOES GLM footprint (SAMPLE, approximate)' }, geometry: { type: 'Polygon', coordinates: [[[-165, -45], [-150, -58], [-110, -62], [-70, -62], [-30, -55], [-12, -40], [-8, 0], [-12, 40], [-30, 55], [-70, 60], [-110, 60], [-150, 55], [-165, 40], [-168, 0], [-165, -45]]] } },
      { type: 'Feature', properties: { source: 'damini', name: 'India regional feed (SAMPLE, rough rectangle, approximate)' }, geometry: { type: 'Polygon', coordinates: [[[68, 6], [98, 6], [98, 37], [68, 37], [68, 6]]] } }
    ]
  });
  json('lightning/index.json', {
    schema: 1, generated: '2026-11-01T20:00:00Z', updated: UPD, window_minutes: 60, count: rows.length, stale: false,
    sources: [
      { id: 'goes-glm', name: 'NOAA GOES GLM (SAMPLE, synthetic)', licence: 'Synthetic data for development only', attribution: 'NOAA GOES-R GLM (sample)', kind: 'satellite', time_precision: 'exact', time_uncertainty_s: 0, unofficial: false, satellites: ['G19', 'G18'], latency_s: 60, stale: false, updated: UPD, coverage: 'lightning/coverage.geojson' },
      { id: 'damini', name: 'Regional ground network, India (SAMPLE)', licence: 'Synthetic data for development only', attribution: 'Damini lightning alert (IITM Pune), unofficial feed (sample)', kind: 'ground-network', time_precision: 'bucketed', time_uncertainty_s: 300, unofficial: true, latency_s: 300, stale: false, updated: UPD, coverage: 'lightning/coverage.geojson' }
    ],
    notes: 'SAMPLE fixtures that follow CONTRACTS 6.1 (two sources, src column, null energy, bucketed times).'
  });
}

// ---------- hazards ----------
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pt = (lon, lat, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000] }, properties: props });
const events = [];
const evSpots = [
  ['wildfire', 'Wildfire, California', -120.5, 38.3], ['wildfire', 'Wildfire, Portugal', -8.1, 40.2], ['wildfire', 'Bushfire, New South Wales', 149.5, -33.2],
  ['wildfire', 'Wildfire, Siberia', 105, 58], ['volcano', 'Etna activity, Italy', 14.99, 37.75], ['volcano', 'Kilauea eruption, Hawaii', -155.28, 19.41],
  ['volcano', 'Merapi, Indonesia', 110.44, -7.54], ['flood', 'Flooding, Bangladesh', 90.4, 23.8], ['flood', 'Flooding, Brazil', -51.2, -30.0],
  ['storm', 'Severe storm, Gulf of Mexico', -90, 25], ['other', 'Dust storm, Sahara', 5, 22], ['wildfire', 'Wildfire, British Columbia', -122, 51]
];
evSpots.forEach(([kind, title, lon, lat], i) => events.push(pt(lon, lat, { id: `EONET_${1000 + i}`, kind, title, time: iso(-rnd() * 60), url: 'https://eonet.gsfc.nasa.gov/', source: 'NASA EONET (sample)' })));
json('hazards/events.geojson', { type: 'FeatureCollection', features: events });

const quakes = [];
const regions = [[142, 38, 8], [-72, -30, 7], [120, 14, 8], [-150, 60, 8], [70, 36, 5], [105, -7, 7], [-100, 17, 5], [27, 38, 4], [-178, -20, 5], [90, 28, 3]];
for (let i = 0; i < 70; i++) {
  const [lo, la, s] = pick(regions);
  const mag = Math.round((2.5 + Math.pow(rnd(), 3) * 4.3) * 10) / 10;
  quakes.push(pt(lo + (rnd() - 0.5) * s * 2, la + (rnd() - 0.5) * s * 2, { id: `us${7000 + i}`, kind: 'quake', title: `M ${mag} - region ${i}`, time: iso(-rnd() * 24), url: 'https://earthquake.usgs.gov/earthquakes/', source: 'USGS (sample)', mag, depth_km: Math.round(rnd() * 300) }));
}
json('hazards/quakes.geojson', { type: 'FeatureCollection', features: quakes });

const fires = [];
const fireZones = [[-120, 38, 4], [20, -10, 12], [100, 20, 6], [-55, -10, 8], [145, -30, 5], [30, 5, 6]];
for (let i = 0; i < 400; i++) {
  const [lo, la, s] = pick(fireZones);
  fires.push(pt(lo + (rnd() - 0.5) * s * 2, la + (rnd() - 0.5) * s * 2, { id: `f${i}`, kind: 'wildfire', title: 'Fire hotspot', time: iso(-rnd() * 24), url: 'https://firms.modaps.eosdis.nasa.gov/', source: 'NASA FIRMS (sample)', frp: Math.round(rnd() * 120 * 10) / 10, confidence: pick(['low', 'nominal', 'high']) }));
}
json('hazards/fires.geojson', { type: 'FeatureCollection', features: fires });
json('hazards/index.json', {
  schema: 1, generated: '2026-11-01T05:00:00Z',
  layers: { events: { count: events.length, source: 'NASA EONET (sample)' }, quakes: { count: quakes.length, source: 'USGS (sample)' }, fires: { count: fires.length, source: 'NASA FIRMS (sample)' } }
});
console.log('sample written to', root);
