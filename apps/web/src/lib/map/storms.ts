import type { GeoJSONSource, Map as MlMap, ExpressionSpecification } from 'maplibre-gl';
import type { ActiveStorms, HistoryCollection } from '#lib/data/contracts';
import { nearestStormId } from '#lib/data/active';
import { positionAt } from '#lib/map/stormTime';
import { categoryFromLabel, categoryFromWind, colorFor, CATEGORIES } from '#lib/util/storm';

/** Layers a click can resolve to an active storm. */
export const ACTIVE_HIT_LAYERS = ['st-core', 'st-glow', 'st-track', 'st-forecast', 'st-cone-fill'];
export const HISTORY_LAYER = 'st-history';
const ALL = [
  'st-history', 'st-history-glow', 'st-history-hl', 'st-cone-fill', 'st-cone-line', 'st-track', 'st-track-pts', 'st-forecast', 'st-fc-pts',
  'st-fc-label', 'st-glow', 'st-core', 'st-ring', 'st-label'
];
const ACTIVE_LAYERS = ALL.filter((l) => !l.startsWith('st-history'));

const colorExpr = ['get', 'color'] as ExpressionSpecification;
const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;

export function addStormLayers(map: Map_): void {
  map.addSource('st-history', { type: 'geojson', data: empty });
  map.addSource('st-lines', { type: 'geojson', data: empty });
  map.addSource('st-pts', { type: 'geojson', data: empty });
  const only = (kind: string): ExpressionSpecification => ['==', ['get', 'kind'], kind];
  const noSel: ExpressionSpecification = ['==', ['get', 'id'], '__none__'];

  map.addLayer({ id: 'st-history', type: 'line', source: 'st-history', layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': colorExpr, 'line-opacity': 0.28, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1.6] } });
  map.addLayer({ id: 'st-history-glow', type: 'line', source: 'st-history', filter: noSel, layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.2, 'line-width': 9, 'line-blur': 6 } });
  map.addLayer({ id: 'st-history-hl', type: 'line', source: 'st-history', filter: noSel, layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' }, paint: { 'line-color': colorExpr, 'line-opacity': 1, 'line-width': 3 } });

  map.addLayer({ id: 'st-cone-fill', type: 'fill', source: 'st-lines', filter: only('cone'), paint: { 'fill-color': '#9fd8ff', 'fill-opacity': 0.24 } });
  map.addLayer({ id: 'st-cone-line', type: 'line', source: 'st-lines', filter: only('cone'), paint: { 'line-color': '#c8e9ff', 'line-opacity': 0.9, 'line-width': 1.5 } });
  map.addLayer({ id: 'st-track', type: 'line', source: 'st-lines', filter: only('track'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#e8f3ff', 'line-opacity': 0.85, 'line-width': 2 } });
  map.addLayer({ id: 'st-track-pts', type: 'circle', source: 'st-pts', filter: only('trackpt'), paint: { 'circle-color': colorExpr, 'circle-radius': 3, 'circle-stroke-color': '#050914', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'st-forecast', type: 'line', source: 'st-lines', filter: only('forecast'), layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': 2, 'line-dasharray': [1.6, 1.6] } });
  map.addLayer({ id: 'st-fc-pts', type: 'circle', source: 'st-pts', filter: only('fcpt'), paint: { 'circle-color': colorExpr, 'circle-radius': 4.5, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2 } });
  map.addLayer({
    id: 'st-fc-label', type: 'symbol', source: 'st-pts', filter: ['all', only('fcpt'), ['>', ['get', 'tau'], 0]], minzoom: 3.2,
    layout: { 'text-field': ['concat', '+', ['to-string', ['get', 'tau']], 'h'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-offset': [0, 1.3], 'text-allow-overlap': false },
    paint: { 'text-color': '#dbe8ff', 'text-halo-color': '#050914', 'text-halo-width': 1.2 }
  });
  map.addLayer({ id: 'st-glow', type: 'circle', source: 'st-pts', filter: only('position'), paint: { 'circle-color': colorExpr, 'circle-radius': 16, 'circle-blur': 0.9, 'circle-opacity': 0.55, 'circle-pitch-alignment': 'map' } });
  map.addLayer({ id: 'st-ring', type: 'circle', source: 'st-pts', filter: noSel, paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-radius': 17, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.9 } });
  map.addLayer({ id: 'st-core', type: 'circle', source: 'st-pts', filter: only('position'), paint: { 'circle-color': colorExpr, 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({
    id: 'st-label', type: 'symbol', source: 'st-pts', filter: only('position'),
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, 1.9], 'text-anchor': 'top', 'text-allow-overlap': true, 'text-letter-spacing': 0.06 },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#050914', 'text-halo-width': 1.6 }
  });
}
type Map_ = MlMap;

/** `validMs`: the time slider's time; storms with a forecast are drawn where the forecast puts them then. */
export function setActiveData(map: Map_, active: ActiveStorms, validMs: number | null = null): void {
  const lines: GeoJSON.Feature[] = [];
  const pts: GeoJSON.Feature[] = [];
  const names = new Map<string, string>();
  for (const f of active.features) {
    if (f.properties.kind === 'position') names.set(f.properties.id, f.properties.name ?? f.properties.id);
  }
  for (const f of active.features) {
    const p = f.properties;
    if (p.kind === 'position') {
      const tp = validMs === null ? null : positionAt(active, p.id, validMs);
      const wind = tp?.forecast && tp.wind !== null ? tp.wind : p.wind_kt;
      const cat = tp?.forecast ? categoryFromWind(wind) : categoryFromLabel(p.category.label, p.wind_kt);
      const geometry: GeoJSON.Point = tp ? { type: 'Point', coordinates: [tp.lon, tp.lat] } : (f.geometry as GeoJSON.Point);
      pts.push({ type: 'Feature', geometry, properties: { kind: 'position', id: p.id, label: p.name ?? p.id, color: cat.color, cat: cat.label, wind, projected: tp?.forecast ?? false } });
    } else if (p.kind === 'track') {
      lines.push({ type: 'Feature', geometry: f.geometry as GeoJSON.LineString, properties: { kind: 'track', id: p.id } });
      (f.geometry as GeoJSON.LineString).coordinates.forEach((c, i) => {
        pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: 'trackpt', id: p.id, color: categoryFromWind(p.wind_kt[i]).color } });
      });
    } else if (p.kind === 'forecast') {
      // forecast has no id in the contract list; derive it from the nearest position by proximity of the first vertex
      const id = p.id ?? nearestStormId(active, (f.geometry as GeoJSON.LineString).coordinates[0]!);
      lines.push({ type: 'Feature', geometry: f.geometry as GeoJSON.LineString, properties: { kind: 'forecast', id } });
      (f.geometry as GeoJSON.LineString).coordinates.forEach((c, i) => {
        pts.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { kind: 'fcpt', id, tau: p.taus[i], color: colorFor(p.category[i], p.wind_kt[i]) } });
      });
    } else {
      lines.push({ type: 'Feature', geometry: f.geometry as GeoJSON.Polygon, properties: { kind: 'cone', id: p.id } });
    }
  }
  (map.getSource('st-lines') as GeoJSONSource).setData({ type: 'FeatureCollection', features: lines });
  (map.getSource('st-pts') as GeoJSONSource).setData({ type: 'FeatureCollection', features: pts });
}

export function setHistoryData(map: Map_, hist: HistoryCollection): void {
  const features = hist.features.map((f) => ({
    ...f,
    properties: { ...f.properties, color: colorFor(f.properties.category, f.properties.max_wind_kt) }
  }));
  (map.getSource('st-history') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
}

export function setStormVisibility(map: Map_, v: { storms: boolean; history: boolean }): void {
  for (const l of ACTIVE_LAYERS) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', v.storms ? 'visible' : 'none');
  for (const l of ['st-history', 'st-history-glow', 'st-history-hl']) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', v.history ? 'visible' : 'none');
}

/** Highlight the selected storm (history line and/or active ring). */
export function setHighlight(map: Map_, sel: { type: 'active' | 'history'; id: string } | null): void {
  const id = sel?.id ?? '__none__';
  const f: ExpressionSpecification = ['==', ['get', 'id'], id];
  map.setFilter('st-history-hl', sel?.type === 'history' ? f : ['==', ['get', 'id'], '__none__']);
  map.setFilter('st-history-glow', sel?.type === 'history' ? f : ['==', ['get', 'id'], '__none__']);
  map.setFilter('st-ring', sel?.type === 'active' ? ['all', ['==', ['get', 'kind'], 'position'], f] : ['==', ['get', 'id'], '__none__']);
  if (sel?.type === 'history') {
    map.setLayoutProperty('st-history-hl', 'visibility', 'visible');
    map.setLayoutProperty('st-history-glow', 'visibility', 'visible');
  }
}

/** Pulsing glow around current positions. Returns a stop function. */
export function startPulse(map: Map_): () => void {
  let raf = 0;
  let last = 0;
  const loop = (t: number) => {
    raf = requestAnimationFrame(loop);
    if (t - last < 42 || document.hidden) return;
    last = t;
    if (!map.getLayer('st-glow')) return;
    const k = (Math.sin(t / 520) + 1) / 2;
    map.setPaintProperty('st-glow', 'circle-radius', 15 + k * 9);
    map.setPaintProperty('st-glow', 'circle-opacity', 0.62 - k * 0.3);
  };
  raf = requestAnimationFrame(loop);
  return () => {
    cancelAnimationFrame(raf);
    if (map.getLayer('st-glow')) {
      map.setPaintProperty('st-glow', 'circle-radius', 18);
      map.setPaintProperty('st-glow', 'circle-opacity', 0.5);
    }
  };
}

export { CATEGORIES };
