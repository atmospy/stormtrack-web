import { Map as MLMap, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { SCALAR_RAMPS, ScalarLayer, buildIsobarSet, createIsobarWorker, decodeScalarImage, physicalRange, rampColorAt, type IsobarResult, type ScalarFrameMeta, type ScalarRamp } from '../src/index.js';
import { SYNTH_META, blobToBitmap, synthImage, toBitmap, type SynthField } from './synth.js';

setWorkerUrl(workerUrl);
const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const win = window as unknown as Record<string, unknown>;

const DEFAULT_RAMP: Record<string, ScalarRamp> = { mslp: SCALAR_RAMPS.pressure, t2m: SCALAR_RAMPS.temperature, precip: SCALAR_RAMPS.precipitation };
const EMPTY = { type: 'FeatureCollection', features: [] } as const;

const style: StyleSpecification = {
  version: 8,
  projection: { type: q.get('projection') === 'mercator' ? 'mercator' : 'globe' },
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    iso: { type: 'geojson', data: EMPTY as never },
    isoLabels: { type: 'geojson', data: EMPTY as never },
    centres: { type: 'geojson', data: EMPTY as never },
    land: { type: 'geojson', data: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson' },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0a1424' } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#16233a' } },
    { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': '#3a557f', 'line-width': 0.6 } },
  ],
};

const map = new MLMap({
  container: 'map',
  style,
  center: [Number(q.get('lon') ?? 80), Number(q.get('lat') ?? 20)],
  zoom: Number(q.get('zoom') ?? 1.8),
  attributionControl: false,
});
win.map = map;

let kind: SynthField = (q.get('field') as SynthField) ?? 'mslp';
const layer = new ScalarLayer({ id: 'field', ramp: DEFAULT_RAMP[kind]!, opacity: Number(q.get('opacity') ?? 0.8) });
win.layer = layer;
const isoWorker = typeof Worker !== 'undefined' ? createIsobarWorker() : null;

interface Frames { meta: ScalarFrameMeta; a: ImageBitmap; b: ImageBitmap | null }
const cache: Partial<Record<SynthField, Frames>> = {};
let real: Record<string, { meta: ScalarFrameMeta; frames: string[] }> | null = null;

async function discoverReal(): Promise<void> {
  const base = q.get('data');
  if (!base) return;
  try {
    const idx = await (await fetch(`${base}/weather/index.json`)).json();
    const m = idx.models.find((x: { id: string }) => x.id === (q.get('model') ?? 'gfs')) ?? idx.models[0];
    const lat = await (await fetch(`${base}/${m.latest}`)).json();
    real = {};
    for (const f of lat.fields) {
      if (f.kind !== 'scalar') continue;
      real[f.id] = { meta: { grid: lat.grid, range: f.range, transform: f.transform }, frames: f.frames.map((fr: { png: string }) => `${base}/${fr.png}`) };
    }
    $('src').textContent = `(${m.id} ${lat.run})`;
  } catch (e) {
    console.warn('real data unavailable, using procedural field', e);
    real = null;
  }
}

async function frames(k: SynthField): Promise<Frames> {
  if (cache[k]) return cache[k]!;
  let fr: Frames;
  const r = real?.[k];
  if (r) {
    const idx = Number(q.get('fhr') ?? 1);
    const get = async (i: number) => blobToBitmap(await (await fetch(r.frames[Math.min(i, r.frames.length - 1)]!)).blob());
    fr = { meta: r.meta, a: await get(idx), b: r.frames.length > idx + 1 ? await get(idx + 1) : null };
  } else {
    fr = { meta: SYNTH_META[k], a: await toBitmap(synthImage(k, 0)), b: await toBitmap(synthImage(k, 1)) };
  }
  cache[k] = fr;
  return fr;
}

function legend(k: SynthField, fr: Frames): void {
  const ramp = DEFAULT_RAMP[$<HTMLSelectElement>('rampSel').value] ?? (SCALAR_RAMPS as Record<string, ScalarRamp>)[$<HTMLSelectElement>('rampSel').value] ?? DEFAULT_RAMP[k]!;
  const [lo, hi] = physicalRange(fr.meta);
  const sq = fr.meta.transform === 'sqrt';
  const stops: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const v = sq ? (Math.sqrt(lo) + t * (Math.sqrt(hi) - Math.sqrt(lo))) ** 2 : lo + t * (hi - lo);
    const [r, g, b, a] = rampColorAt(ramp, [lo, hi], v, sq);
    stops.push(`rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${(t * 100).toFixed(0)}%`);
  }
  $('legend').style.background = `linear-gradient(90deg,${stops.join(',')}), #0a1424`;
  $('ticks').innerHTML = [lo, (lo + hi) / 2, hi].map((v) => `<span>${v.toFixed(0)}</span>`).join('');
}

let isoOn = q.get('iso') !== '0';
let isoSeq = 0;
async function contours(k: SynthField, fr: Frames): Promise<void> {
  const my = ++isoSeq;
  const src = (id: string) => map.getSource(id) as GeoJSONSource;
  if (!isoOn || k !== 'mslp') {
    src('iso').setData(EMPTY as never);
    src('isoLabels').setData(EMPTY as never);
    src('centres').setData(EMPTY as never);
    return;
  }
  const t0 = performance.now();
  const opts = { interval: 4, base: 1000, smooth: 1 };
  const res: IsobarResult = isoWorker ? await isoWorker.isobars(fr.a, fr.meta, opts) : buildIsobarSet(decodeScalarImage(fr.a, fr.meta), opts);
  if (my !== isoSeq) return;
  win.isoMs = performance.now() - t0;
  src('iso').setData(res.lines as never);
  src('isoLabels').setData(res.labels as never);
  src('centres').setData(res.centres as never);
}

async function show(k: SynthField): Promise<void> {
  kind = k;
  const fr = await frames(k);
  const sel = $<HTMLSelectElement>('rampSel').value;
  layer.setRamp(sel ? (SCALAR_RAMPS as Record<string, ScalarRamp>)[sel]! : DEFAULT_RAMP[k]!);
  layer.setFrame(fr.meta, fr.a, fr.b, Number($<HTMLInputElement>('mix').value));
  legend(k, fr);
  await contours(k, fr);
}

map.on('load', async () => {
  await discoverReal();
  map.addLayer({ id: 'iso', type: 'line', source: 'iso', paint: { 'line-color': '#e8f0ff', 'line-opacity': ['case', ['get', 'major'], 0.95, 0.55], 'line-width': ['case', ['get', 'major'], 1.4, 0.8] } });
  map.addLayer({ id: 'isoLabels', type: 'symbol', source: 'isoLabels', layout: { 'text-field': ['get', 'text'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-rotate': ['get', 'angle'], 'text-rotation-alignment': 'map', 'text-allow-overlap': false }, paint: { 'text-color': '#ffffff', 'text-halo-color': '#0a1424', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'centres', type: 'symbol', source: 'centres', layout: { 'text-field': ['concat', ['get', 'type'], '\n', ['to-string', ['get', 'value']]], 'text-font': ['Noto Sans Regular'], 'text-size': 15, 'text-allow-overlap': true }, paint: { 'text-color': ['match', ['get', 'type'], 'H', '#7cc4ff', '#ff7c7c'], 'text-halo-color': '#0a1424', 'text-halo-width': 2 } });
  map.addLayer(layer, 'iso');
  await show(kind);
  $<HTMLSelectElement>('field').value = kind;
  win.ready = true;
});

// ---- UI
$<HTMLSelectElement>('field').onchange = (e) => void show((e.target as HTMLSelectElement).value as SynthField);
$<HTMLSelectElement>('rampSel').onchange = () => void show(kind);
const bind = (id: string, apply: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  const f = () => {
    $(`${id}O`).textContent = (+el.value).toFixed(2);
    apply(+el.value);
  };
  el.addEventListener('input', f);
  $(`${id}O`).textContent = (+el.value).toFixed(2);
};
$<HTMLInputElement>('opacity').value = String(q.get('opacity') ?? 0.8);
bind('opacity', (v) => layer.setOptions({ opacity: v }));
bind('mix', (v) => layer.setMix(v));
let globe = style.projection?.type !== 'mercator';
$('proj').textContent = globe ? 'mercator' : 'globe';
$('proj').onclick = () => {
  globe = !globe;
  map.setProjection({ type: globe ? 'globe' : 'mercator' });
  $('proj').textContent = globe ? 'mercator' : 'globe';
};
$('iso').onclick = () => {
  isoOn = !isoOn;
  $('iso').textContent = `isobars: ${isoOn ? 'on' : 'off'}`;
  void contours(kind, cache[kind]!);
};
let vis = true;
$('vis').onclick = () => {
  vis = !vis;
  layer.setVisible(vis);
  $('vis').textContent = vis ? 'hide' : 'show';
};
let frames_ = 0, tAcc = performance.now();
map.on('render', () => frames_++);
setInterval(() => {
  const now = performance.now();
  const fps = (frames_ * 1000) / (now - tAcc);
  frames_ = 0;
  tAcc = now;
  $('stats').textContent = `render ${fps.toFixed(0)} /s${win.isoMs ? `\nisobars ${(win.isoMs as number).toFixed(0)} ms (worker)` : ''}`;
}, 1000);
map.on('mousemove', (e) => {
  const v = layer.sample(e.lngLat.lng, e.lngLat.lat);
  $('probe').textContent = v === null ? 'no data' : `${e.lngLat.lng.toFixed(1)}, ${e.lngLat.lat.toFixed(1)}  ${kind} ${v.toFixed(kind === 'precip' ? 2 : 1)}`;
});
