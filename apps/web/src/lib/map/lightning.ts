import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';

export const LIGHTNING_LAYERS = ['lightning-cov-mask', 'lightning-cov-line'];
const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

export function addLightningLayers(map: MlMap, before?: string): void {
  map.addSource('lightning-cov', { type: 'geojson', data: empty });
  map.addLayer({ id: 'lightning-cov-mask', type: 'fill', source: 'lightning-cov', filter: ['==', ['get', 'role'], 'mask'], layout: { visibility: 'none' }, paint: { 'fill-color': '#050914', 'fill-opacity': 0.34 } }, before);
  map.addLayer({ id: 'lightning-cov-line', type: 'line', source: 'lightning-cov', filter: ['==', ['get', 'role'], 'edge'], layout: { visibility: 'none', 'line-join': 'round' }, paint: { 'line-color': '#ffd24a', 'line-opacity': 0.55, 'line-width': 1.1, 'line-dasharray': [3, 2] } }, before);
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
