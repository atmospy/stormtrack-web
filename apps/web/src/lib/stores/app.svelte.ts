import type { ActiveStorms, BasinStats, HazardIndex } from '#lib/data/contracts';
import type { WeatherIndexEntry, WeatherModel } from '#lib/data/weather';
import { levelKey, nearestIndex, primaryField, timeline, variablesOf, windFieldAt, type Variable } from '#lib/weather/select';
import type { WindSample } from '#lib/weather/sample';
import { gate } from './gate.svelte';

export type LayerKey = 'wind' | 'storms' | 'history' | 'events' | 'quakes' | 'fires' | 'lightning';
export type Availability = 'loading' | 'ready' | 'missing' | 'error';
export interface Selection {
  type: 'active' | 'history';
  id: string;
}
export interface Readout {
  lon: number;
  lat: number;
  sample: WindSample | null;
  /** value of the active scalar field at the point (if any) */
  scalar?: number | null;
  pinned: boolean;
}
export interface LoadedModel {
  model: WeatherModel;
  base: string;
}

class AppState {
  reducedMotion = $state(false);
  /** wind rendering: animated particles or static arrow field */
  windMode = $state<'particles' | 'arrows'>('particles');

  layers = $state<Record<LayerKey, boolean>>({ wind: true, storms: true, history: false, events: true, quakes: true, fires: false, lightning: false });
  availability = $state<Record<LayerKey, Availability>>({ wind: 'loading', storms: 'loading', history: 'loading', events: 'loading', quakes: 'loading', fires: 'loading', lightning: 'ready' });
  notes = $state<Partial<Record<LayerKey, string>>>({});

  // ---- weather catalogue (CONTRACTS 1b, with legacy section 1 fallback) ----
  catalogue = $state.raw<WeatherIndexEntry[]>([]);
  models = $state.raw<Record<string, LoadedModel>>({});
  weatherSample = $state(false);
  weatherLegacy = $state(false);
  modelId = $state('gfs');
  variable = $state<Variable>('wind');
  level = $state('10m');
  /** wind particles drawn over a scalar field */
  overlay = $state(true);
  /** valid time, epoch ms: the one shared clock for every field */
  validMs = $state<number | null>(null);
  playing = $state(false);

  active = $state.raw<ActiveStorms | null>(null);
  stormsSample = $state(false);
  stormsUpdated = $state<string | null>(null);
  statsBasins = $state<string[]>(['NI']);
  stats = $state.raw<Record<string, BasinStats>>({});
  hazardIndex = $state.raw<HazardIndex | null>(null);
  hazardsSample = $state(false);
  hazards = $state.raw<Partial<Record<'events' | 'quakes' | 'fires', GeoJSON.FeatureCollection>>>({});

  selection = $state<Selection | null>(null);
  readout = $state<Readout | null>(null);
  center = $state({ lon: 80, lat: 18 });
  zoom = $state(1.3);
  userLocation = $state<{ lon: number; lat: number } | null>(null);

  paletteOpen = $state(false);
  authOpen = $state(false);
  helpOpen = $state(false);

  /** commands the map component executes (fly-to etc.) */
  flyRequest = $state.raw<{ lon: number; lat: number; zoom?: number; bounds?: [number, number, number, number]; n: number } | null>(null);
  private flyN = 0;

  // ---- derived weather selection ----
  get loadedModel(): LoadedModel | null {
    return this.models[this.modelId] ?? null;
  }
  get model(): WeatherModel | null {
    return this.loadedModel?.model ?? null;
  }
  /** the field that defines the time axis for the current selection */
  get primary() {
    const m = this.model;
    return m ? primaryField(m, this.variable, this.level) : null;
  }
  get times(): number[] {
    return timeline(this.primary);
  }
  get frameIdx(): number {
    const t = this.times;
    return this.validMs === null ? 0 : nearestIndex(t, this.validMs);
  }
  get frame() {
    return this.primary?.frames[this.frameIdx] ?? null;
  }
  get weatherReady(): boolean {
    return this.model !== null && this.availability.wind === 'ready';
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
    const t = this.times;
    if (!t.length) return;
    this.validMs = t[Math.max(0, Math.min(t.length - 1, i))]!;
  }

  /** Switch model keeping variable/level/time where the new model has them (nearest otherwise). */
  setModel(id: string): void {
    const lm = this.models[id];
    if (!lm) return;
    this.modelId = id;
    this.normalise();
  }
  setVariable(v: Variable): void {
    this.variable = v;
    this.normalise();
  }
  setLevel(l: string): void {
    this.level = l;
    this.variable = 'wind';
    this.normalise();
  }
  /** Make variable/level valid for the current model; snap the time into its range. */
  normalise(): void {
    const m = this.model;
    if (!m) return;
    if (!variablesOf(m).includes(this.variable)) this.variable = 'wind';
    const wf = windFieldAt(m, this.level);
    if (wf) this.level = levelKey(wf);
    const t = this.times;
    if (t.length && (this.validMs === null || this.validMs < t[0]! || this.validMs > t[t.length - 1]!)) {
      this.validMs = t[nearestIndex(t, this.validMs ?? Date.now())]!;
    }
  }
}

export const app = new AppState();
