import type { ActiveStorms, BasinStats, HazardIndex, HistoryCollection, WindLatest } from '#lib/data/contracts';
import type { WindSample } from '#lib/wind/field';
import { gate } from './gate.svelte';

export type LayerKey = 'wind' | 'storms' | 'history' | 'events' | 'quakes' | 'fires';
export type Availability = 'loading' | 'ready' | 'missing' | 'error';
export interface Selection {
  type: 'active' | 'history';
  id: string;
}
export interface Readout {
  lon: number;
  lat: number;
  sample: WindSample | null;
  pinned: boolean;
}

class AppState {
  reducedMotion = $state(false);
  /** wind rendering: animated particles or static arrow field */
  windMode = $state<'particles' | 'arrows'>('particles');

  layers = $state<Record<LayerKey, boolean>>({ wind: true, storms: true, history: false, events: true, quakes: true, fires: false });
  availability = $state<Record<LayerKey, Availability>>({ wind: 'loading', storms: 'loading', history: 'loading', events: 'loading', quakes: 'loading', fires: 'loading' });
  notes = $state<Partial<Record<LayerKey, string>>>({});

  wind = $state.raw<WindLatest | null>(null);
  windBase = $state('');
  windSample = $state(false);
  frameIdx = $state(0);
  frameLoading = $state(false);
  playing = $state(false);

  active = $state.raw<ActiveStorms | null>(null);
  stormsSample = $state(false);
  stormsUpdated = $state<string | null>(null);
  history = $state.raw<HistoryCollection | null>(null);
  statsBasins = $state<string[]>(['NI']);
  stats = $state.raw<Record<string, BasinStats>>({});
  hazardIndex = $state.raw<HazardIndex | null>(null);
  hazardsSample = $state(false);
  hazards = $state.raw<Partial<Record<'events' | 'quakes' | 'fires', GeoJSON.FeatureCollection>>>({});

  selection = $state<Selection | null>(null);
  readout = $state<Readout | null>(null);
  center = $state({ lon: 80, lat: 18 });
  userLocation = $state<{ lon: number; lat: number } | null>(null);

  paletteOpen = $state(false);
  authOpen = $state(false);
  helpOpen = $state(false);

  /** commands the map component executes (fly-to etc.) */
  flyRequest = $state.raw<{ lon: number; lat: number; zoom?: number; bounds?: [number, number, number, number]; n: number } | null>(null);
  private flyN = 0;

  get frame() {
    return this.wind?.frames[this.frameIdx] ?? null;
  }

  flyTo(lon: number, lat: number, zoom?: number): void {
    this.flyRequest = { lon, lat, zoom, n: ++this.flyN };
  }
  flyToBounds(bounds: [number, number, number, number]): void {
    this.flyRequest = { lon: 0, lat: 0, bounds, n: ++this.flyN };
  }

  /** Toggle a layer, counting it as a meaningful interaction. */
  toggle(key: LayerKey, value?: boolean): void {
    if (this.availability[key] === 'missing' || this.availability[key] === 'error') return;
    this.layers[key] = value ?? !this.layers[key];
    gate.interact();
  }

  select(sel: Selection | null, countInteraction = true): void {
    this.selection = sel;
    if (sel && countInteraction) gate.interact();
  }

  scrubTo(i: number): void {
    if (!this.wind) return;
    const n = this.wind.frames.length;
    this.frameIdx = Math.max(0, Math.min(n - 1, i));
  }
}

export const app = new AppState();
