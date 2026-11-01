import { DATA_BASE, SAMPLE_BASE } from '#lib/config';
import { app } from '#lib/stores/app.svelte';
import { windRuntime } from '#lib/wind/runtime.svelte';
import { loadActive, loadHazardIndex, loadHazardLayer, loadHistory, loadStats, loadStormsIndex, loadWind } from './load';

type HazardName = 'events' | 'quakes' | 'fires';
let hazardBase = '';
let stormsBase: string = DATA_BASE;

/** Kick off every data request in parallel; each failure only disables its own layer. */
export function bootData(signal?: AbortSignal): Promise<void> {
  return Promise.all([bootWind(signal), bootStorms(signal), bootHazards(signal)]).then(() => undefined);
}

async function bootWind(signal?: AbortSignal): Promise<void> {
  const r = await loadWind(signal);
  if (!r.ok) {
    app.availability.wind = r.missing ? 'missing' : 'error';
    app.notes.wind = r.error;
    app.layers.wind = false;
    return;
  }
  app.wind = r.value.data;
  app.windBase = r.value.base;
  app.windSample = r.value.sample;
  windRuntime.init(r.value.data, r.value.base);
  app.availability.wind = 'ready';
  // start downloading frame 0 right away, in parallel with the map library
  void windRuntime.show(0);
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
    const hb = idx?.history && typeof idx.history === 'object' ? Object.keys(idx.history) : null;
    if (hb?.length) app.statsBasins = hb;
  }
}

/** Lazy: the history file can be large, so it is fetched when first needed. */
let historyPromise: Promise<void> | null = null;
export function ensureHistory(): Promise<void> {
  historyPromise ??= (async () => {
    app.availability.history = 'loading';
    let r = await loadHistory('NI', stormsBase);
    if (!r.ok && r.missing && stormsBase !== SAMPLE_BASE) r = await loadHistory('NI', SAMPLE_BASE);
    if (!r.ok) {
      app.availability.history = r.missing ? 'missing' : 'error';
      app.notes.history = r.error;
      app.layers.history = false;
      return;
    }
    app.history = r.value.data;
    app.availability.history = 'ready';
  })();
  return historyPromise;
}

const statsPromises = new Map<string, Promise<void>>();
export function ensureStats(basin: string): Promise<void> {
  let p = statsPromises.get(basin);
  if (!p) {
    p = (async () => {
      let r = await loadStats(basin, stormsBase);
      if (!r.ok && r.missing && stormsBase !== SAMPLE_BASE) r = await loadStats(basin, SAMPLE_BASE);
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
