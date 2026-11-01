import { MAP } from '#lib/config';
import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';

/**
 * Custom dark, low-key basemap on OpenFreeMap vector tiles (OpenMapTiles schema, no API key).
 * Deliberately quiet so wind, storms and hazards carry the visual weight.
 */
const C = {
  land: '#141f38',
  water: '#060b18',
  landcover: '#18253f',
  boundary: '#34476b',
  boundaryState: '#243250',
  road: '#1c2943',
  label: '#9fb3d6',
  labelDim: '#6b7fa3',
  halo: '#050914'
};

const font = (w: 'Regular' | 'Bold' | 'Italic') => [`Noto Sans ${w}`];

export function darkStyle(): StyleSpecification {
  const layers: LayerSpecification[] = [
    { id: 'background', type: 'background', paint: { 'background-color': C.land } },
    { id: 'landcover', type: 'fill', source: 'ofm', 'source-layer': 'landcover', paint: { 'fill-color': C.landcover, 'fill-opacity': 0.7 } },
    { id: 'park', type: 'fill', source: 'ofm', 'source-layer': 'park', minzoom: 5, paint: { 'fill-color': C.landcover, 'fill-opacity': 0.8 } },
    { id: 'landuse', type: 'fill', source: 'ofm', 'source-layer': 'landuse', minzoom: 8, filter: ['in', 'class', 'residential', 'commercial', 'industrial'], paint: { 'fill-color': '#1a2744', 'fill-opacity': 0.8 } },
    { id: 'water', type: 'fill', source: 'ofm', 'source-layer': 'water', paint: { 'fill-color': C.water } },
    { id: 'waterway', type: 'line', source: 'ofm', 'source-layer': 'waterway', minzoom: 7, paint: { 'line-color': C.water, 'line-width': 1 } },
    { id: 'building', type: 'fill', source: 'ofm', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': '#15203a', 'fill-opacity': 0.8 } },
    {
      id: 'road_major', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 7,
      filter: ['in', 'class', 'motorway', 'trunk', 'primary'],
      paint: { 'line-color': C.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 12, 1.6] }
    },
    {
      id: 'road_minor', type: 'line', source: 'ofm', 'source-layer': 'transportation', minzoom: 11,
      filter: ['in', 'class', 'secondary', 'tertiary', 'minor', 'service'],
      paint: { 'line-color': '#16223a', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.3, 16, 1.5] }
    },
    {
      id: 'boundary_state', type: 'line', source: 'ofm', 'source-layer': 'boundary', minzoom: 4,
      filter: ['all', ['==', 'admin_level', 4], ['!=', 'maritime', 1]],
      paint: { 'line-color': C.boundaryState, 'line-width': 0.6, 'line-dasharray': [3, 2] }
    },
    {
      id: 'boundary_country', type: 'line', source: 'ofm', 'source-layer': 'boundary',
      filter: ['all', ['==', 'admin_level', 2], ['!=', 'maritime', 1]],
      paint: { 'line-color': C.boundary, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.2], 'line-opacity': 0.9 }
    },
    {
      id: 'water_label', type: 'symbol', source: 'ofm', 'source-layer': 'water_name', minzoom: 2,
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': font('Italic'), 'text-size': 11, 'text-letter-spacing': 0.15, 'text-max-width': 6 },
      paint: { 'text-color': '#33507a', 'text-halo-color': C.halo, 'text-halo-width': 1 }
    },
    {
      id: 'label_place_small', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 6,
      filter: ['in', 'class', 'city', 'town', 'village'],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': font('Regular'),
        'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 12, 14], 'text-max-width': 8
      },
      paint: { 'text-color': C.labelDim, 'text-halo-color': C.halo, 'text-halo-width': 1.2 }
    },
    {
      id: 'label_state', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 4, maxzoom: 9,
      filter: ['==', 'class', 'state'],
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': font('Italic'), 'text-size': 11, 'text-transform': 'uppercase', 'text-letter-spacing': 0.1, 'text-max-width': 7 },
      paint: { 'text-color': '#4b6089', 'text-halo-color': C.halo, 'text-halo-width': 1 }
    },
    {
      id: 'label_city', type: 'symbol', source: 'ofm', 'source-layer': 'place', minzoom: 3,
      filter: ['==', 'class', 'city'],
      layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': font('Regular'), 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 10, 15], 'text-max-width': 8, 'symbol-sort-key': ['get', 'rank'] },
      paint: { 'text-color': C.label, 'text-halo-color': C.halo, 'text-halo-width': 1.4 }
    },
    {
      id: 'label_country', type: 'symbol', source: 'ofm', 'source-layer': 'place', maxzoom: 7,
      filter: ['==', 'class', 'country'],
      layout: {
        'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': font('Bold'),
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 5, 14], 'text-transform': 'uppercase', 'text-letter-spacing': 0.14, 'text-max-width': 7
      },
      paint: { 'text-color': '#7f95bd', 'text-halo-color': C.halo, 'text-halo-width': 1.4, 'text-opacity': 0.9 }
    }
  ];
  return {
    version: 8,
    name: 'stormtrack-dark',
    projection: { type: 'globe' },
    sky: {
      'sky-color': '#02050d',
      'horizon-color': '#1b4a8a',
      'fog-color': '#0a1a38',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.6,
      'fog-ground-blend': 0.3,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 7, 0]
    },
    sources: { ofm: { type: 'vector', url: MAP.openFreeMapTiles, attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' } },
    glyphs: MAP.glyphs,
    layers
  } as StyleSpecification;
}
