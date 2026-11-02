import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';

export const SONDE_HIT_LAYERS = ['sonde-pts'];
const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

/** Altitude colour: low yellow, mid green, high cyan, stratosphere violet. */
const altColor: ExpressionSpecification = ['interpolate', ['linear'], ['get', 'alt'], 0, '#ffd24d', 8000, '#6be38f', 18000, '#4dd2ff', 32000, '#b58cff'];

export function addSondeLayers(map: MlMap): void {
  map.addSource('sondes-lines', { type: 'geojson', data: empty });
  map.addSource('sondes-pts', { type: 'geojson', data: empty });
  map.addLayer({ id: 'sonde-lines', type: 'line', source: 'sondes-lines', layout: { visibility: 'none' }, paint: { 'line-color': '#e8f3ff', 'line-opacity': 0.6, 'line-width': 1.2 } });
  map.addLayer({
    id: 'sonde-pts', type: 'circle', source: 'sondes-pts', layout: { visibility: 'none' },
    paint: { 'circle-color': altColor, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 3, 8, 6], 'circle-stroke-color': ['case', ['get', 'falling'], '#ff6b6b', '#050914'], 'circle-stroke-width': ['case', ['get', 'falling'], 2, 1] }
  });
  map.addLayer({
    id: 'sonde-label', type: 'symbol', source: 'sondes-pts', minzoom: 5, layout: { visibility: 'none', 'text-field': ['concat', ['to-string', ['round', ['/', ['get', 'alt'], 100]]], '00 m'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#dbe8ff', 'text-halo-color': '#050914', 'text-halo-width': 1.2 }
  });
}

export function setSondeData(map: MlMap, g: { points: GeoJSON.FeatureCollection; lines: GeoJSON.FeatureCollection }): void {
  (map.getSource('sondes-pts') as GeoJSONSource | undefined)?.setData(g.points);
  (map.getSource('sondes-lines') as GeoJSONSource | undefined)?.setData(g.lines);
}

export function setSondeVisibility(map: MlMap, on: boolean): void {
  for (const l of ['sonde-lines', 'sonde-pts', 'sonde-label']) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
}

/** Popup body for one sonde. */
export function sondePopup(p: Record<string, unknown>): HTMLElement {
  const d = document.createElement('div');
  const rows: [string, string][] = [
    ['Serial', String(p.serial)],
    ['Type', String(p.type || 'unknown')],
    ['Altitude', `${Number(p.alt).toLocaleString('en')} m`],
    ['State', p.falling ? 'descending' : typeof p.velV === 'number' && p.velV > 1 ? 'ascending' : 'level / near ground'],
    ['Temperature', typeof p.temp === 'number' ? `${p.temp.toFixed(1)} °C` : '–'],
    ['Humidity', typeof p.humidity === 'number' ? `${Math.round(p.humidity)} %` : '–'],
    ['Last packet', `${p.ageS} s ago`]
  ];
  const h = document.createElement('b');
  h.textContent = 'Radiosonde';
  d.append(h);
  for (const [k, v] of rows) {
    const r = document.createElement('div');
    r.textContent = `${k}: ${v}`;
    d.append(r);
  }
  return d;
}
