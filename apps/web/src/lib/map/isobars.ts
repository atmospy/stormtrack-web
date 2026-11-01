import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { IsobarResult } from '#lib/scalar/adapter';

export const ISO_LINES = 'iso-lines';
const IDS = ['iso-lines', 'iso-labels', 'iso-centres', 'iso-centre-values'];
const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

/** MapLibre sources/layers for isobars, H/L centres. Added once at map load (hidden until MSLP is shown). */
export function addIsobarLayers(map: MlMap, before?: string): void {
  map.addSource('iso-lines', { type: 'geojson', data: empty });
  map.addSource('iso-labels', { type: 'geojson', data: empty });
  map.addSource('iso-centres', { type: 'geojson', data: empty });
  const font = ['Noto Sans Regular'];
  map.addLayer({
    id: 'iso-lines', type: 'line', source: 'iso-lines', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#e6eefc', 'line-opacity': ['case', ['get', 'major'], 0.85, 0.5], 'line-width': ['case', ['get', 'major'], 1.5, 0.8] }
  }, before);
  map.addLayer({
    id: 'iso-labels', type: 'symbol', source: 'iso-labels', minzoom: 1.5,
    layout: { visibility: 'none', 'text-field': ['get', 'text'], 'text-font': font, 'text-size': 11, 'text-rotate': ['get', 'angle'], 'text-rotation-alignment': 'map', 'text-pitch-alignment': 'map', 'text-allow-overlap': false, 'text-padding': 2 },
    paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(5,9,20,0.85)', 'text-halo-width': 1.4 }
  }, before);
  map.addLayer({
    id: 'iso-centres', type: 'symbol', source: 'iso-centres',
    layout: { visibility: 'none', 'text-field': ['get', 'type'], 'text-font': ['Noto Sans Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 18, 5, 28], 'text-allow-overlap': true },
    paint: { 'text-color': ['match', ['get', 'type'], 'H', '#ff9d5c', '#5ec8ff'], 'text-halo-color': 'rgba(5,9,20,0.9)', 'text-halo-width': 2 }
  }, before);
  map.addLayer({
    id: 'iso-centre-values', type: 'symbol', source: 'iso-centres', minzoom: 2,
    layout: { visibility: 'none', 'text-field': ['to-string', ['round', ['get', 'value']]], 'text-font': font, 'text-size': 11, 'text-offset': [0, 1.4], 'text-allow-overlap': false },
    paint: { 'text-color': '#e6eefc', 'text-halo-color': 'rgba(5,9,20,0.9)', 'text-halo-width': 1.4 }
  }, before);
}

export function setIsobars(map: MlMap, r: IsobarResult | null): void {
  const set = (id: string, d: unknown) => (map.getSource(id) as GeoJSONSource | undefined)?.setData((d ?? empty) as GeoJSON.FeatureCollection);
  set('iso-lines', r?.lines);
  set('iso-labels', r?.labels);
  set('iso-centres', r?.centres);
}
export function setIsobarVisibility(map: MlMap, on: boolean): void {
  for (const id of IDS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}
