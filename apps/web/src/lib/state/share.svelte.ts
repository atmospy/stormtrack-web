import { app, type LayerKey } from '#lib/stores/app.svelte';
import { history } from '#lib/history/state.svelte';
import { lightning } from '#lib/lightning/state.svelte';
import { LAYER_KEYS, parse, serialize, type ShareState } from './url';

/** State found in the URL when the page loaded (read once; the map and boot code consult it). */
export const restored: ShareState = typeof location !== 'undefined' ? parse(location.search) : {};

/** Apply everything except the camera (MapView) and history basins (needs the index; see applyRestoredHistory). */
export function applyRestored(): void {
  const r = restored;
  if (r.model) app.modelId = r.model;
  if (r.variable) app.variable = r.variable;
  if (r.level) app.level = r.level;
  if (r.t !== undefined) app.validMs = r.t;
  if (r.overlay !== undefined) app.overlay = r.overlay;
  if (r.layers) for (const k of LAYER_KEYS) app.layers[k as LayerKey] = r.layers.includes(k);
  if (r.selection) app.selection = r.selection;
  if (r.lightningWindow) lightning.window = r.lightningWindow;
  if (r.years) history.years = r.years;
  if (r.minCategory !== undefined) history.minCategory = r.minCategory;
}
export function applyRestoredHistory(): void {
  if (restored.basins) history.setEnabled(restored.basins);
}

/** The shareable state of the app right now. `pin` is the live meteogram point. */
export function currentShareState(pin: { lon: number; lat: number } | null): ShareState {
  const layers = LAYER_KEYS.filter((k) => app.layers[k as LayerKey]);
  const s: ShareState = {
    lat: app.center.lat, lon: app.center.lon, zoom: app.zoom,
    model: app.modelId, variable: app.variable, level: app.level,
    layers, overlay: app.overlay, lightningWindow: lightning.window
  };
  if (app.validMs !== null) s.t = app.validMs;
  if (app.selection) s.selection = app.selection;
  if (pin) s.pin = pin;
  if (app.layers.history) {
    s.basins = history.enabled;
    if (history.years) s.years = history.years;
    if (history.minCategory > 0) s.minCategory = history.minCategory;
  }
  return s;
}

export function shareUrl(pin: { lon: number; lat: number } | null): string {
  const q = serialize(currentShareState(pin));
  return `${location.origin}${location.pathname}${q ? '?' + q : ''}`;
}
