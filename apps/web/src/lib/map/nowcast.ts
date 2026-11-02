/** India district nowcast warnings (IMD): district polygons coloured by IMD's own warning colour. */
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';

const SRC = 'nowcast';
const FILL = 'nowcast-fill';
export const NOWCAST_HIT_LAYERS = [FILL];
const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const LEVEL_LABEL: Record<number, string> = { 1: 'Light', 2: 'Moderate', 3: 'Severe' };

/** Added under the storm layers so tracks and markers stay on top of the warning colours. */
export function addNowcastLayers(map: MlMap, before?: string): void {
  map.addSource(SRC, { type: 'geojson', data: empty });
  const above = before && map.getLayer(before) ? before : undefined;
  map.addLayer(
    {
      id: FILL, type: 'fill', source: SRC, layout: { visibility: 'none' },
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['match', ['get', 'level'], 1, 0.28, 2, 0.42, 0.55] }
    },
    above
  );
  map.addLayer(
    {
      id: `${FILL}-line`, type: 'line', source: SRC, layout: { visibility: 'none' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.4], 'line-opacity': 0.85 }
    },
    above
  );
}

export function setNowcastData(map: MlMap, data: GeoJSON.FeatureCollection): void {
  (map.getSource(SRC) as GeoJSONSource | undefined)?.setData(data);
}

export function setNowcastVisibility(map: MlMap, on: boolean): void {
  for (const l of [FILL, `${FILL}-line`]) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', on ? 'visible' : 'none');
}

const IST = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** "02 Nov, 22:00 IST" from a UTC ISO string; empty when it does not parse. */
export function istLabel(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : `${IST.format(t).replace(',', '')} IST`;
}

/** Popup body, built with DOM APIs only (the feed text is untrusted). */
export function nowcastPopup(props: Record<string, unknown>): HTMLElement {
  const root = document.createElement('div');
  root.className = 'popup';
  const level = typeof props.level === 'number' ? props.level : 1;
  const h = document.createElement('div');
  h.className = 'popup-kind';
  h.style.color = typeof props.color === 'string' ? props.color : '#ffbf00';
  h.textContent = `${LEVEL_LABEL[level] ?? 'Warning'} nowcast warning`;
  const t = document.createElement('div');
  t.className = 'popup-title';
  t.textContent = String(props.district ?? 'District');
  root.append(h, t);
  const warnings = Array.isArray(props.warnings) ? (props.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : [];
  for (const w of warnings) {
    const p = document.createElement('div');
    p.className = 'popup-meta';
    p.textContent = w;
    root.append(p);
  }
  const until = typeof props.valid_until === 'string' ? istLabel(props.valid_until) : '';
  if (until) {
    const m = document.createElement('div');
    m.className = 'popup-meta tnum';
    m.textContent = `Valid until ${until}`;
    root.append(m);
  }
  const src = document.createElement('span');
  src.className = 'popup-link';
  src.textContent = 'IMD district nowcast';
  root.append(src);
  return root;
}
