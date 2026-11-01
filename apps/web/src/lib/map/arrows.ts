import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import type { WindSample } from '#lib/weather/sample';
interface WindField { sample(lon: number, lat: number): WindSample | null }

export function addArrowLayer(map: MlMap): void {
  const S = 48;
  const c = new OffscreenCanvas(S, S);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath(); // arrow pointing up (north)
  g.moveTo(S / 2, 4);
  g.lineTo(S / 2 + 11, 26);
  g.lineTo(S / 2 + 3.5, 23);
  g.lineTo(S / 2 + 3.5, 44);
  g.lineTo(S / 2 - 3.5, 44);
  g.lineTo(S / 2 - 3.5, 23);
  g.lineTo(S / 2 - 11, 26);
  g.closePath();
  g.fill();
  map.addImage('wind-arrow', g.getImageData(0, 0, S, S), { pixelRatio: 2, sdf: true });
  map.addSource('wind-arrows', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'wind-arrows', type: 'symbol', source: 'wind-arrows', layout: { visibility: 'none', 'icon-image': 'wind-arrow', 'icon-rotate': ['get', 'rot'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['get', 'speed'], 0, 0.4, 10, 0.65, 30, 1] },
    paint: {
      'icon-opacity': 0.9,
      'icon-color': ['interpolate', ['linear'], ['get', 'speed'], 0, '#3b6bd8', 3, '#2fb4e0', 6, '#36d9a6', 10, '#a6e84a', 15, '#f5e04a', 20, '#fba03a', 27, '#ee4d4d', 35, '#d83bd0']
    }
  }, 'label_place_small');
}

/** Sample a regular lon/lat grid over the viewport into arrow features (a static fallback for reduced motion). */
export function updateArrows(map: MlMap, field: WindField): void {
  const b = map.getBounds();
  const z = map.getZoom();
  let west = b.getWest(), east = b.getEast();
  let south = Math.max(-80, b.getSouth()), north = Math.min(80, b.getNorth());
  if (z < 3.2 || east - west >= 300 || east < west) {
    west = -180;
    east = 180;
    south = -75;
    north = 75;
  }
  const lonSpan = east - west, latSpan = north - south;
  const target = 450;
  let step = Math.max(0.5, Math.sqrt((lonSpan * latSpan) / target));
  step = Math.round(step * 2) / 2 || 0.5;
  const feats: GeoJSON.Feature[] = [];
  for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
    // thin out toward the poles so spacing stays roughly even on the sphere
    const lonStep = step / Math.max(0.35, Math.cos((lat * Math.PI) / 180));
    for (let lon = Math.ceil(west / lonStep) * lonStep; lon <= east; lon += lonStep) {
      const s = field.sample(lon, lat);
      if (!s) continue;
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { speed: Math.round(s.speed * 10) / 10, rot: Math.round((s.deg + 180) % 360) } });
    }
  }
  (map.getSource('wind-arrows') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
}
