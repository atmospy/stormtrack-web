import type { ExpressionSpecification, GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { HistoryCollection } from '#lib/data/contracts';
import { colorFor } from '#lib/util/storm';
import { peakRank } from '#lib/history/state.svelte';

/** Decorate loaded storms with colour + numeric rank/year for filter expressions (the geometry is not copied). */
export function decorate(c: HistoryCollection, basin: string): GeoJSON.Feature<GeoJSON.LineString | GeoJSON.MultiLineString>[] {
  return c.features.map((f) => ({
    type: 'Feature' as const,
    geometry: f.geometry,
    properties: { ...f.properties, basin: f.properties.basin ?? basin, color: colorFor(f.properties.category, f.properties.max_wind_kt), rank: peakRank(f.properties) }
  }));
}

export interface HistoryFilter {
  basins: string[];
  years: [number, number];
  minCategory: number;
  /** ids to emphasise (storms near the clicked point); null = no emphasis */
  near: string[] | null;
}

export function historyFilter(f: HistoryFilter): ExpressionSpecification {
  return ['all', ['in', ['get', 'basin'], ['literal', f.basins]], ['>=', ['get', 'year'], f.years[0]], ['<=', ['get', 'year'], f.years[1]], ['>=', ['get', 'rank'], f.minCategory]];
}

/** Update data (only when a basin is first loaded) -- filters are applied separately, cheaply, with setFilter. */
export function setHistorySource(map: MlMap, feats: GeoJSON.Feature[]): void {
  (map.getSource('st-history') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats });
}

export function applyHistoryFilter(map: MlMap, f: HistoryFilter): void {
  if (!map.getLayer('st-history')) return;
  map.setFilter('st-history', historyFilter(f));
  const near = f.near;
  map.setPaintProperty('st-history', 'line-opacity', near ? ['case', ['in', ['get', 'id'], ['literal', near]], 0.95, 0.07] : 0.3);
  map.setPaintProperty('st-history', 'line-width', near
    ? ['case', ['in', ['get', 'id'], ['literal', near]], 2.4, 0.6]
    : ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1.6]);
}
