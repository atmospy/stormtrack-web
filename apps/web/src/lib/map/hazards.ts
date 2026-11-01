import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { LayerKey } from '#lib/stores/app.svelte';

const KIND_COLORS: Record<string, string> = {
  wildfire: '#ff8a3d',
  volcano: '#ff4d6a',
  flood: '#4da3ff',
  storm: '#b58cff',
  other: '#9aa7c2',
  quake: '#ffd24d'
};

/** Draw a 28px icon (2x) for each hazard kind: dark disc, coloured ring, simple glyph. */
function makeIcon(kind: string): ImageData {
  const S = 56;
  const c = new OffscreenCanvas(S, S);
  const g = c.getContext('2d')!;
  const col = KIND_COLORS[kind] ?? KIND_COLORS.other!;
  g.translate(S / 2, S / 2);
  g.shadowColor = col;
  g.shadowBlur = 8;
  g.fillStyle = 'rgba(5,9,20,0.92)';
  g.strokeStyle = col;
  g.lineWidth = 3;
  g.beginPath();
  g.arc(0, 0, 18, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.shadowBlur = 0;
  g.fillStyle = col;
  g.strokeStyle = col;
  g.lineWidth = 2.6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  switch (kind) {
    case 'wildfire': // flame
      g.moveTo(0, -11);
      g.bezierCurveTo(9, -3, 10, 3, 6, 8);
      g.bezierCurveTo(3, 12, -3, 12, -6, 8);
      g.bezierCurveTo(-9, 4, -6, -2, -3, -4);
      g.bezierCurveTo(-3, 0, -1, 1, 0, -1);
      g.bezierCurveTo(1, -5, 0, -8, 0, -11);
      g.fill();
      break;
    case 'volcano': // cone + plume
      g.moveTo(-10, 10);
      g.lineTo(-4, -2);
      g.lineTo(4, -2);
      g.lineTo(10, 10);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(0, -5);
      g.lineTo(0, -12);
      g.stroke();
      break;
    case 'flood': // drop
      g.moveTo(0, -11);
      g.bezierCurveTo(8, -1, 9, 3, 6, 8);
      g.bezierCurveTo(3, 12, -3, 12, -6, 8);
      g.bezierCurveTo(-9, 3, -8, -1, 0, -11);
      g.fill();
      break;
    case 'storm': // spiral
      for (let a = 0; a < 9; a += 0.25) {
        const r = 1.2 + a * 1.1;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (a === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      break;
    default: // diamond
      g.moveTo(0, -10);
      g.lineTo(9, 0);
      g.lineTo(0, 10);
      g.lineTo(-9, 0);
      g.closePath();
      g.fill();
  }
  return g.getImageData(0, 0, S, S);
}

const KIND_MATCH = (prefix: string): ExpressionSpecification => [
  'match', ['get', 'kind'],
  'wildfire', `${prefix}wildfire`, 'volcano', `${prefix}volcano`, 'flood', `${prefix}flood`, 'storm', `${prefix}storm`,
  `${prefix}other`
];

const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

export const HAZARD_HIT_LAYERS = ['hz-ev-icon', 'hz-ev-cluster', 'hz-quakes', 'hz-fires-pt'];

export function addHazardLayers(map: MlMap): void {
  for (const k of Object.keys(KIND_COLORS)) if (!map.hasImage(`hz-${k}`)) map.addImage(`hz-${k}`, makeIcon(k), { pixelRatio: 2 });

  map.addSource('hz-events', { type: 'geojson', data: empty, cluster: true, clusterRadius: 42, clusterMaxZoom: 5 });
  map.addSource('hz-quakes', { type: 'geojson', data: empty });
  map.addSource('hz-fires', { type: 'geojson', data: empty });

  // fires: heat at low zoom, dots when zoomed in
  map.addLayer({
    id: 'hz-fires-heat', type: 'heatmap', source: 'hz-fires', maxzoom: 7, layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['coalesce', ['get', 'frp'], 10], 0, 0.2, 100, 1],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 6, 2],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 4, 6, 18],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,90,0,0)', 0.25, 'rgba(255,120,30,0.5)', 0.6, 'rgba(255,190,60,0.8)', 1, 'rgba(255,245,200,0.95)'],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.9, 7, 0]
    }
  });
  map.addLayer({
    id: 'hz-fires-pt', type: 'circle', source: 'hz-fires', minzoom: 5, layout: { visibility: 'none' },
    paint: { 'circle-color': '#ff9a3d', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2, 10, 5], 'circle-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 7, 0.85], 'circle-stroke-color': '#ffd9a8', 'circle-stroke-width': 0.6 }
  });

  const mag: ExpressionSpecification = ['coalesce', ['get', 'mag'], 2.5];
  map.addLayer({
    id: 'hz-quakes', type: 'circle', source: 'hz-quakes', layout: { 'circle-sort-key': mag as ExpressionSpecification, visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], mag, 2.5, 3, 4.5, 6, 6, 11, 7.5, 18],
      'circle-color': ['interpolate', ['linear'], mag, 2.5, '#ffe9a0', 4.5, '#ffb03b', 6, '#ff5a3d', 7.5, '#ff2e7a'],
      'circle-opacity': 0.55,
      'circle-stroke-color': ['interpolate', ['linear'], mag, 2.5, '#ffe9a0', 6, '#ff5a3d'],
      'circle-stroke-width': 1.2,
      'circle-stroke-opacity': 0.95
    }
  });

  map.addLayer({
    id: 'hz-ev-cluster', type: 'circle', source: 'hz-events', filter: ['has', 'point_count'], layout: { visibility: 'none' },
    paint: { 'circle-color': 'rgba(255,138,61,0.22)', 'circle-stroke-color': '#ff8a3d', 'circle-stroke-width': 1.5, 'circle-radius': ['step', ['get', 'point_count'], 14, 5, 18, 15, 24] }
  });
  map.addLayer({
    id: 'hz-ev-cluster-n', type: 'symbol', source: 'hz-events', filter: ['has', 'point_count'], layout: { 'text-field': '{point_count_abbreviated}', 'text-font': ['Noto Sans Bold'], 'text-size': 12, visibility: 'none' },
    paint: { 'text-color': '#ffe6d0' }
  });
  map.addLayer({
    id: 'hz-ev-icon', type: 'symbol', source: 'hz-events', filter: ['!', ['has', 'point_count']],
    layout: { 'icon-image': KIND_MATCH('hz-'), 'icon-size': ['interpolate', ['linear'], ['zoom'], 1, 0.7, 6, 1], 'icon-allow-overlap': true, visibility: 'none' }
  });
}

const SRC: Record<'events' | 'quakes' | 'fires', string> = { events: 'hz-events', quakes: 'hz-quakes', fires: 'hz-fires' };
export function setHazardData(map: MlMap, name: 'events' | 'quakes' | 'fires', data: GeoJSON.FeatureCollection): void {
  (map.getSource(SRC[name]) as GeoJSONSource).setData(data);
}

const GROUPS: Record<'events' | 'quakes' | 'fires', string[]> = {
  events: ['hz-ev-cluster', 'hz-ev-cluster-n', 'hz-ev-icon'],
  quakes: ['hz-quakes'],
  fires: ['hz-fires-heat', 'hz-fires-pt']
};
export function setHazardVisibility(map: MlMap, key: Extract<LayerKey, 'events' | 'quakes' | 'fires'>, on: boolean): void {
  for (const l of GROUPS[key]) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
}

export const KIND_LABEL: Record<string, string> = {
  wildfire: 'Wildfire', volcano: 'Volcano', flood: 'Flood', storm: 'Severe storm', quake: 'Earthquake', other: 'Event'
};

/** Build a popup body with DOM APIs only (feed content is untrusted). */
export function popupContent(props: Record<string, unknown>, layer: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'popup';
  const kind = layer === 'hz-quakes' ? 'quake' : layer === 'hz-fires-pt' ? 'wildfire' : String(props.kind ?? 'other');
  const h = document.createElement('div');
  h.className = 'popup-kind';
  h.style.color = KIND_COLORS[kind] ?? KIND_COLORS.other!;
  h.textContent = KIND_LABEL[kind] ?? 'Event';
  const t = document.createElement('div');
  t.className = 'popup-title';
  t.textContent = String(props.title ?? KIND_LABEL[kind] ?? 'Event');
  root.append(h, t);
  const meta: string[] = [];
  if (typeof props.mag === 'number') meta.push(`M ${props.mag.toFixed(1)}`);
  if (typeof props.depth_km === 'number') meta.push(`${Math.round(props.depth_km)} km deep`);
  if (typeof props.frp === 'number') meta.push(`FRP ${props.frp} MW`);
  if (typeof props.confidence === 'string') meta.push(`confidence ${props.confidence}`);
  if (typeof props.time === 'string' && !Number.isNaN(Date.parse(props.time))) meta.push(new Date(props.time).toUTCString().replace(' GMT', ' UTC').slice(5));
  if (meta.length) {
    const m = document.createElement('div');
    m.className = 'popup-meta tnum';
    m.textContent = meta.join(' · ');
    root.append(m);
  }
  const url = typeof props.url === 'string' && /^https?:\/\//i.test(props.url) ? props.url : null;
  const src = typeof props.source === 'string' ? props.source : '';
  if (url || src) {
    const a = document.createElement(url ? 'a' : 'span');
    a.className = 'popup-link';
    a.textContent = (src || 'Source') + (url ? ' ↗' : '');
    if (url) {
      (a as HTMLAnchorElement).href = url;
      (a as HTMLAnchorElement).target = '_blank';
      (a as HTMLAnchorElement).rel = 'noopener noreferrer';
    }
    root.append(a);
  }
  return root;
}
