import { DATA_BASE, SAMPLE_BASE } from '#lib/config';
import { app } from '#lib/stores/app.svelte';
import { history } from '#lib/history/state.svelte';
import { applyRestoredHistory } from '#lib/state/share.svelte';
import { weather } from '#lib/weather/runtime.svelte';
import { nearestIndex } from '#lib/weather/select';
import { loadActive, loadCatalogue, loadHazardIndex, loadHazardLayer, loadHistoryIndex, loadStats, loadStormsIndex } from './load';

type HazardName = 'events' | 'quakes' | 'fires';
let hazardBase = '';
let stormsBase: string = DATA_BASE;

/** Kick off every data request in parallel; each failure only disables its own layer. */
export function bootData(signal?: AbortSignal): Promise<void> {
  return Promise.all([bootWeather(signal), bootStorms(signal), bootHazards(signal)]).then(() => undefined);
}

async function bootWeather(signal?: AbortSignal): Promise<void> {
  const r = await loadCatalogue(signal);
  if (!r.ok) {
    app.availability.wind = r.missing ? 'missing' : 'error';
    app.notes.wind = r.error;
    app.layers.wind = false;
    return;
  }
  const { entries, first, base, sample, legacy } = r.value;
  app.catalogue = entries;
  app.models = { ...app.models, [first.model]: { model: first, base } };
  app.weatherSample = sample;
  app.weatherLegacy = legacy;
  // a URL-restored model wins when this catalogue lists it (applyRestored ran before boot)
  if (app.modelId !== first.model && entries.some((e) => e.id === app.modelId)) await weather.ensureModel(app.modelId);
  if (!app.models[app.modelId]) app.modelId = first.model;
  if (app.validMs === null) {
    // default: the frame nearest to "now" (the run's analysis is hours old)
    const t = app.times;
    app.validMs = t.length ? t[nearestIndex(t, Date.now())]! : null;
  }
  app.normalise();
  app.availability.wind = 'ready';
  // other models' pointer files are tiny: load them right away so the model switch is instant
  for (const e of entries) if (e.id !== first.model) void weather.ensureModel(e.id);
}

async function bootStorms(signal?: AbortSignal): Promise<void> {
  const r = await loadActive(signal);
  if (!r.ok) {
    app.availability.storms = r.missing ? 'missing' : 'error';
    app.notes.storms = r.error;
    app.layers.storms = false;
  } else {
    app.active = r.value.data;
    app.stormsSample = r.value.sample;
    stormsBase = r.value.base;
    app.availability.storms = 'ready';
    const times = r.value.data.features.filter((f) => f.properties.kind === 'position').map((f) => (f.properties as { time: string }).time).sort();
    const idx = await loadStormsIndex(r.value.base, signal);
    const upd = (idx?.active as { updated?: string } | undefined)?.updated;
    app.stormsUpdated = upd ?? times[times.length - 1] ?? null;
  }
  await bootHistoryIndex(signal);
}

async function bootHistoryIndex(signal?: AbortSignal): Promise<void> {
  let r = await loadHistoryIndex(stormsBase, signal);
  if (!r.ok && r.missing && stormsBase !== SAMPLE_BASE) {
    r = await loadHistoryIndex(SAMPLE_BASE, signal);
    if (r.ok) stormsBase = SAMPLE_BASE;
  }
  if (!r.ok) {
    app.availability.history = r.missing ? 'missing' : 'error';
    app.notes.history = r.error;
    app.layers.history = false;
    return;
  }
  history.setIndex(r.index, stormsBase);
  applyRestoredHistory();
  app.statsBasins = r.index.basins.map((b) => b.code);
  app.availability.history = 'ready';
}

/** Lazy: a basin file can be large, so it is fetched when its checkbox is first ticked. */
export function ensureHistory(): Promise<void> {
  if (!history.index) return Promise.resolve();
  if (history.enabled.length === 0) {
    // sensible first choice: the basin of the strongest active storm, else the first listed
    const strongest = app.active?.features
      .filter((f) => f.properties.kind === 'position')
      .sort((a, b) => ((b.properties as { wind_kt: number | null }).wind_kt ?? 0) - ((a.properties as { wind_kt: number | null }).wind_kt ?? 0))[0];
    const b = (strongest?.properties as { basin?: string } | undefined)?.basin;
    const pick = history.entries.find((e) => e.code === b)?.code ?? history.entries.find((e) => e.code === 'NI')?.code ?? history.entries[0]?.code;
    if (pick) history.toggleBasin(pick, true);
  }
  return Promise.all(history.enabled.map((c) => history.ensure(c))).then(() => undefined);
}

const statsPromises = new Map<string, Promise<void>>();
export function ensureStats(basin: string): Promise<void> {
  let p = statsPromises.get(basin);
  if (!p) {
    p = (async () => {
      const file = history.entries.find((e) => e.code === basin)?.stats;
      let r = await loadStats(basin, stormsBase, undefined, file);
      if (!r.ok && r.missing && stormsBase !== SAMPLE_BASE) r = await loadStats(basin, SAMPLE_BASE, undefined, file);
      if (r.ok) app.stats = { ...app.stats, [basin]: r.value.data };
    })();
    statsPromises.set(basin, p);
  }
  return p;
}

async function bootHazards(signal?: AbortSignal): Promise<void> {
  const idx = await loadHazardIndex(signal);
  const names: HazardName[] = ['events', 'quakes', 'fires'];
  if (!idx.ok) {
    for (const n of names) {
      app.availability[n] = idx.missing ? 'missing' : 'error';
      app.layers[n] = false;
    }
    return;
  }
  app.hazardIndex = idx.value.data;
  app.hazardsSample = idx.value.sample;
  hazardBase = idx.value.base;
  await Promise.all(
    names.map(async (n) => {
      if (!idx.value.data.layers[n]) {
        app.availability[n] = 'missing';
        app.notes[n] = 'Not produced in the latest run';
        app.layers[n] = false;
        return;
      }
      const r = await loadHazardLayer(n, hazardBase, signal);
      if (!r.ok) {
        app.availability[n] = r.missing ? 'missing' : 'error';
        app.notes[n] = r.error;
        app.layers[n] = false;
        return;
      }
      app.hazards = { ...app.hazards, [n]: r.value.data };
      app.availability[n] = 'ready';
    })
  );
}
