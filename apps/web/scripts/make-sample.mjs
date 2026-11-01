// Generates a small, contract-compliant sample data set under public-data/sample/.
// Usage: pnpm --filter web sample
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
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
json('storms/index.json', {
  schema: 1, generated: '2026-11-01T05:00:00Z',
  active: { count: 2, updated: iso(0), sources: ['JTWC'] },
  history: { NI: { count: hist.length, year_min: 1999, year_max: 2023, sources: ['SAMPLE'] } }
});

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
