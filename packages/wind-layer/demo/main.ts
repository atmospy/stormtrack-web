import { Map as MLMap, setWorkerUrl, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { WindLayer, type WindImageMeta } from '../src/index.js';
import { SYNTH_META, blobToBitmap, synthWind, toBitmap } from './synth.js';

setWorkerUrl(workerUrl);
const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function graticule(): any {
  const features: any[] = [];
  for (let lon = -180; lon <= 180; lon += 30)
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: Array.from({ length: 37 }, (_, i) => [lon, -90 + i * 5]) } });
  for (let lat = -60; lat <= 60; lat += 30)
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]) } });
  return { type: 'FeatureCollection', features } as any;
}

const style: StyleSpecification = q.get('style')
  ? (q.get('style') as unknown as StyleSpecification)
  : {
      version: 8,
      projection: { type: q.get('projection') === 'mercator' ? 'mercator' : 'globe' },
      sources: { grat: { type: 'geojson', data: graticule() } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0a1424' } },
        { id: 'grat', type: 'line', source: 'grat', paint: { 'line-color': '#25406a', 'line-width': 0.8 } },
      ],
    };

const map = new MLMap({
  container: 'map',
  style,
  center: [Number(q.get('lon') ?? 80), Number(q.get('lat') ?? 15)],
  zoom: Number(q.get('zoom') ?? 2.2),
  attributionControl: false,
});
(window as unknown as { map: unknown }).map = map;

const layer = new WindLayer({ id: 'wind', particleCount: Number(q.get('n') ?? 32768) });
(window as unknown as { wind: unknown }).wind = layer;

let metaG: WindImageMeta = SYNTH_META;
let bmpA: ImageBitmap;
let bmpB: ImageBitmap | null = null;

async function loadFrames() {
  const base = q.get('data');
  if (base) {
    try {
      const j = await (await fetch(`${base}/wind/latest.json`)).json();
      metaG = j.image;
      const frames = j.frames as Array<{ png: string }>;
      bmpA = await blobToBitmap(await (await fetch(`${base}/${frames[0]!.png}`)).blob());
      if (frames[1]) bmpB = await blobToBitmap(await (await fetch(`${base}/${frames[1].png}`)).blob());
      $('src').textContent = `(${j.source}, run ${j.run})`;
      return;
    } catch (e) {
      console.warn('real data unavailable, falling back to synthetic', e);
    }
  }
  metaG = SYNTH_META;
  bmpA = await toBitmap(synthWind(0));
  bmpB = await toBitmap(synthWind(1));
  $('src').textContent = '(synthetic)';
}

map.on('load', async () => {
  await loadFrames();
  layer.setFrame(metaG, bmpA, bmpB, 0);
  map.addLayer(layer);
  (window as unknown as { ready: boolean }).ready = true;
});

// ---- UI
const bind = (id: string, fmt: (v: number) => string, apply: (v: number) => void) => {
  const el = $<HTMLInputElement>(id);
  const out = $(`${id}O`);
  const f = () => {
    out.textContent = fmt(+el.value);
    apply(+el.value);
  };
  el.addEventListener('input', f);
  out.textContent = fmt(+el.value);
};
$<HTMLInputElement>('count').value = String(q.get('n') ?? 32768);
bind('count', (v) => `${(v / 1000) | 0}k`, (v) => layer.setOptions({ particleCount: v }));
bind('speed', (v) => v.toFixed(1), (v) => layer.setOptions({ speedFactor: v }));
bind('fade', (v) => v.toFixed(3), (v) => layer.setOptions({ fadeOpacity: v }));
bind('width', (v) => v.toFixed(1), (v) => layer.setOptions({ lineWidth: v }));
bind('mix', (v) => v.toFixed(2), (v) => layer.setMix(v));
let globe = style.projection?.type !== 'mercator';
$('proj').textContent = globe ? 'mercator' : 'globe';
$('proj').onclick = () => {
  globe = !globe;
  map.setProjection({ type: globe ? 'globe' : 'mercator' });
  $('proj').textContent = globe ? 'mercator' : 'globe';
};
let rm = false;
$('rm').onclick = () => {
  rm = !rm;
  layer.setOptions({ reducedMotion: rm });
  $('rm').textContent = `reduced motion: ${rm ? 'on' : 'off'}`;
};
let vis = true;
$('vis').onclick = () => {
  vis = !vis;
  layer.setVisible(vis);
  $('vis').textContent = vis ? 'hide' : 'show';
};
let auto = q.has('auto');
$('auto').onclick = () => (auto = !auto);
let t0 = performance.now();
setInterval(() => {
  if (auto) {
    const m = (Math.sin((performance.now() - t0) / 3000) + 1) / 2;
    $<HTMLInputElement>('mix').value = String(m);
    $('mixO').textContent = m.toFixed(2);
    layer.setMix(m);
  }
  const s = layer.getStats();
  $('stats').textContent = `fps ${s.fps.toFixed(0)}  (${s.frameMs.toFixed(1)} ms)\nparticles ${s.particles}/${s.maxParticles}\nstate ${s.state}\nproj ${s.projection}${s.reducedMotion ? '\nreduced-motion' : ''}`;
}, 250);
map.on('mousemove', (e) => {
  const s = layer.sample(e.lngLat.lng, e.lngLat.lat);
  $('probe').textContent = s ? `${e.lngLat.lng.toFixed(1)}, ${e.lngLat.lat.toFixed(1)}  ${s.speed.toFixed(1)} m/s from ${s.deg.toFixed(0)}°` : 'no data';
});
