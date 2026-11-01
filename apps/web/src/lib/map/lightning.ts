import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { Flashes } from '#lib/data/lightning';

export const LIGHTNING_LAYERS = ['lightning-cov-mask', 'lightning-cov-line', 'lightning-flashes'];
const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

export function addLightningLayers(map: MlMap, before?: string): void {
  map.addSource('lightning-cov', { type: 'geojson', data: empty });
  map.addSource('lightning-flashes', { type: 'geojson', data: empty });
  map.addLayer({ id: 'lightning-cov-mask', type: 'fill', source: 'lightning-cov', filter: ['==', ['get', 'role'], 'mask'], layout: { visibility: 'none' }, paint: { 'fill-color': '#050914', 'fill-opacity': 0.34 } }, before);
  map.addLayer({ id: 'lightning-cov-line', type: 'line', source: 'lightning-cov', filter: ['==', ['get', 'role'], 'edge'], layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': '#ffd24a', 'line-opacity': 0.55, 'line-width': 1.1, 'line-dasharray': [3, 2] } }, before);
  map.addLayer({
    id: 'lightning-flashes', type: 'circle', source: 'lightning-flashes', layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 1.1, 4, 2.2, 8, 4.5],
      'circle-color': '#ffd24a',
      'circle-opacity': 0.9,
      'circle-blur': 0.15,
      'circle-pitch-alignment': 'map'
    }
  }, before);
}

export function setLightningVisibility(map: MlMap, on: boolean): void {
  for (const id of LIGHTNING_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
}

/** Coverage footprint: a subtle shaded "outside" mask (world minus footprint) plus a dashed outline. */
export function setCoverage(map: MlMap, cov: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon> | null): void {
  const src = map.getSource('lightning-cov') as GeoJSONSource | undefined;
  if (!src) return;
  if (!cov) {
    src.setData(empty);
    return;
  }
  const holes: number[][][] = [];
  const edges: GeoJSON.Feature[] = [];
  for (const f of cov.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) {
      holes.push(p[0]!.slice().reverse()); // holes wind opposite to the outer ring
      edges.push({ type: 'Feature', properties: { role: 'edge' }, geometry: { type: 'LineString', coordinates: p[0]! } });
    }
  }
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { role: 'mask' }, geometry: { type: 'Polygon', coordinates: [world, ...holes] } }, ...edges] });
}

/** All flashes as GeoJSON points; `t` is seconds since the data's t0 (kept small so float precision is fine). */
export function flashesToGeoJSON(f: Flashes): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const features = new Array<GeoJSON.Feature<GeoJSON.Point>>(f.n);
  for (let i = 0; i < f.n; i++) {
    features[i] = { type: 'Feature', geometry: { type: 'Point', coordinates: [f.lon[i]!, f.lat[i]!] }, properties: { t: f.dt[i]!, e: f.energy[i]! } };
  }
  return { type: 'FeatureCollection', features };
}
export function setFlashes(map: MlMap, f: Flashes | null): void {
  (map.getSource('lightning-flashes') as GeoJSONSource | undefined)?.setData(f ? flashesToGeoJSON(f) : empty);
}

/** Age-based fade: bright and white-yellow when new, dim and orange at the end of the window; fully hidden beyond it. */
export function ageStyle(nowSec: number, windowSec: number): { color: ExpressionSpecification; opacity: ExpressionSpecification } {
  const age: ExpressionSpecification = ['-', nowSec, ['get', 't']];
  return {
    color: ['interpolate', ['linear'], age, 0, '#fffbe0', windowSec * 0.25, '#ffd24a', windowSec * 0.7, '#ff9a3d', windowSec, '#ff5a3d'],
    opacity: ['case', ['>', age, windowSec], 0, ['<', age, 0], 0, ['interpolate', ['linear'], age, 0, 1, windowSec * 0.5, 0.6, windowSec, 0.14]]
  };
}
export function setAgeStyle(map: MlMap, nowSec: number, windowSec: number): void {
  if (!map.getLayer('lightning-flashes')) return;
  const s = ageStyle(nowSec, windowSec);
  map.setPaintProperty('lightning-flashes', 'circle-color', s.color);
  map.setPaintProperty('lightning-flashes', 'circle-opacity', s.opacity);
}
