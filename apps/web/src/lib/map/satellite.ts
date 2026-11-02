/** INSAT infrared image (IMD) as a georeferenced raster, drawn under waterways, borders and labels. */
import type { ImageSource, Map as MlMap } from 'maplibre-gl';

const SRC = 'satellite';
const LAYER = 'satellite-ir';
export const SATELLITE_OPACITY = 0.85;

/** [west, south, east, north] -> the corner order MapLibre wants: top-left, top-right, bottom-right, bottom-left. */
export function cornerCoordinates(b: [number, number, number, number]): [[number, number], [number, number], [number, number], [number, number]] {
  const [w, s, e, n] = b;
  return [[w, n], [e, n], [e, s], [w, s]];
}

/**
 * Show or hide the image. The image is only requested when the layer is first switched on, so visitors who
 * never use it do not download it; later calls just flip visibility, or swap the picture when it changed.
 */
export function setSatellite(map: MlMap, on: boolean, sat: { url: string; bounds: [number, number, number, number] } | null): void {
  if (!sat) return;
  const coordinates = cornerCoordinates(sat.bounds);
  const src = map.getSource(SRC) as ImageSource | undefined;
  if (!src) {
    if (!on) return;
    map.addSource(SRC, { type: 'image', url: sat.url, coordinates });
    const before = map.getLayer('waterway') ? 'waterway' : undefined;
    map.addLayer({ id: LAYER, type: 'raster', source: SRC, paint: { 'raster-opacity': SATELLITE_OPACITY, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } }, before);
    return;
  }
  if ((src as unknown as { url?: string }).url !== sat.url) src.updateImage({ url: sat.url, coordinates });
  if (map.getLayer(LAYER)) map.setLayoutProperty(LAYER, 'visibility', on ? 'visible' : 'none');
}
