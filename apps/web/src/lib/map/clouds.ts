/**
 * Global infrared cloud imagery: NOAA GOES-East, GOES-West and JMA Himawari-9 (band 13, "clean" longwave infrared)
 * as web-mercator tiles from NASA GIBS. One scan every 10 minutes, about 20 to 30 minutes behind real time, and GIBS
 * keeps roughly the last day. The tile time follows the time slider, so scrubbing back plays the clouds back.
 */
import type { Map as MlMap, RasterTileSource } from 'maplibre-gl';

export const CLOUD_SOURCES = [
  { id: 'clouds-himawari', layer: 'Himawari_AHI_Band13_Clean_Infrared' },
  { id: 'clouds-goes-west', layer: 'GOES-West_ABI_Band13_Clean_Infrared' },
  { id: 'clouds-goes-east', layer: 'GOES-East_ABI_Band13_Clean_Infrared' }
] as const;
export const CLOUD_OPACITY = 0.8;
const STEP = 10 * 60_000;
const LAG = 40 * 60_000; // newest scan GIBS has is about 20 to 30 min old; leave margin so tiles are never missing
const HISTORY = 22 * 3_600_000; // GIBS keeps about a day of GOES and Himawari

/** ISO time (UTC, 10-minute step) of the scan to show for a slider time: never newer than GIBS has, never older than it keeps. */
export function cloudTime(validMs: number | null, nowMs: number): string {
  const newest = Math.floor((nowMs - LAG) / STEP) * STEP;
  const want = validMs === null || !Number.isFinite(validMs) ? newest : Math.floor(validMs / STEP) * STEP;
  const t = Math.floor(Math.min(newest, Math.max(nowMs - HISTORY, want)) / STEP) * STEP;
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

export function cloudTileUrl(layer: string, time: string): string {
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${time}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
}

/** Show or hide the clouds at `time`. Sources are created on first use so visitors who never turn the layer on load nothing. */
export function setClouds(map: MlMap, on: boolean, time: string): void {
  for (const s of CLOUD_SOURCES) {
    const tiles = [cloudTileUrl(s.layer, time)];
    const src = map.getSource(s.id) as RasterTileSource | undefined;
    if (!src) {
      if (!on) continue;
      map.addSource(s.id, { type: 'raster', tiles, tileSize: 256, maxzoom: 6, attribution: 'NOAA GOES, JMA Himawari via NASA GIBS' });
      const before = map.getLayer('waterway') ? 'waterway' : undefined;
      map.addLayer({ id: s.id, type: 'raster', source: s.id, paint: { 'raster-opacity': CLOUD_OPACITY, 'raster-fade-duration': 0 } }, before);
      continue;
    }
    if (src.tiles?.[0] !== tiles[0]) src.setTiles(tiles);
    if (map.getLayer(s.id)) map.setLayoutProperty(s.id, 'visibility', on ? 'visible' : 'none');
  }
}
