<script lang="ts">
  import { app } from '#lib/stores/app.svelte';
  import { fmtAgo } from '#lib/util/storm';
  import { weather } from '#lib/weather/runtime.svelte';
  import { lightning } from '#lib/lightning/state.svelte';

  let now = $state(Date.now());
  let open = $state(false);
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 30000);
    return () => clearInterval(id);
  });
  const w = $derived(app.model);
  const run = $derived(w ? new Date(w.run).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC' : '');
  const runShort = $derived(w ? new Date(w.run).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', hour12: false }).replace(', ', ' ') + 'Z run' : '');
  const anySample = $derived(app.weatherSample || app.stormsSample || app.hazardsSample || (app.layers.lightning && lightning.bundle?.sample));
</script>

<footer class="prov">
  <button class="line glass tnum" onclick={() => (open = !open)} aria-expanded={open} aria-label="Data sources and provenance">
    {#if w}<span>{w.name} · {runShort} · {fmtAgo(w.generated, now)}</span>{:else}<span>Loading data…</span>{/if}
    {#if anySample}<span class="sample" title="Sample data in use: {[app.weatherSample && 'weather', app.stormsSample && 'storms', app.hazardsSample && 'hazards', app.layers.lightning && lightning.bundle?.sample && 'lightning'].filter(Boolean).join(', ')}">SAMPLE</span>{/if}
  </button>
  <span class="legal"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></span>
  {#if open}
    <div class="more glass" role="region" aria-label="Data sources">
      <h3>Data &amp; sources</h3>
      <ul>
        {#if w}<li><b>Weather</b> {app.variable === 'wind' ? app.level === '10m' ? '10 m' : app.level + ' hPa' : app.primary?.id} · {w.name} · run {run}, generated {fmtAgo(w.generated, now)}. Licence: {w.licence || 'see source'}. Values are model output on a {w.grid.width >= 1000 ? '~0.25°' : w.grid.width >= 700 ? '~0.5°' : 'coarse'} grid, not observations.{#if w.stale} <b class="e">Pointer marked stale by the producer.</b>{/if}{#if app.weatherSample} <i>Sample/synthetic data.</i>{/if}</li>{/if}
        <li><b>Cyclones</b> NHC / JTWC active systems{#if app.stormsUpdated}, updated {fmtAgo(app.stormsUpdated, now)}{/if}. Winds are 1-minute sustained. Historical tracks: IMD (3-minute winds) and IBTrACS.{#if app.stormsSample} <i>Sample data.</i>{/if}</li>
        <li><b>Events</b> NASA EONET · <b>Earthquakes</b> USGS · <b>Fires</b> NASA FIRMS{#if app.hazardsSample} <i>(sample data)</i>{/if}</li>
        <li><b>Basemap</b> <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>, data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. Place search: Nominatim (OSM) on request.</li>
        {#if app.layers.lightning && lightning.bundle}<li><b>Lightning</b> {lightning.bundle.index.sources.map((x) => x.name).join(', ') || 'feed'}, data {lightning.ageMin ?? '?'} min old{#if lightning.stale} <b class="e">(STALE: the producer kept the previous files)</b>{/if}. {lightning.bundle.index.notes}{#if lightning.bundle.sample} <i>Sample data.</i>{/if}</li>{/if}
        {#if app.layers.nowcast && app.nowcast}<li><b>India warnings</b> IMD district nowcast (unofficial access){#if app.nowcast.newestIssue}, newest issue {fmtAgo(app.nowcast.newestIssue, now)}{/if}. A nowcast is issued about every 3 hours and is valid for about 3 hours. Colours are IMD's.{#if app.nowcast.stale} <b class="e">No new nowcast for over 12 hours.</b>{/if}</li>{/if}
        {#if weather.error}<li class="e">Weather frame error: {weather.error}</li>{/if}
      </ul>
    </div>
  {/if}
</footer>

<style>
  .prov { position: absolute; left: var(--gap); bottom: calc(var(--gap) + var(--safe-b)); z-index: 4; max-width: calc(50vw - 344px); display: flex; align-items: center; gap: 10px; }
  .legal { font-size: 11px; color: var(--text-faint); white-space: nowrap; }
  .legal a { color: inherit; text-decoration: none; }
  .legal a:hover { color: var(--text); text-decoration: underline; }
  .line { max-width: 100%; }
  .line { padding: 5px 10px; font-size: 11px; color: var(--text-dim); display: flex; gap: 8px; align-items: center; border-radius: 9px; text-align: left; }
  .line span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sample { color: var(--warn); font-weight: 700; letter-spacing: 0.08em; font-size: 10px; flex: none; }
  .more { position: absolute; bottom: 34px; left: 0; width: min(480px, calc(100vw - 24px)); padding: 12px 16px; font-size: 12px; color: var(--text-dim); background: var(--glass-strong); }
  h3 { margin: 0 0 6px; font-size: 13px; color: var(--text); }
  ul { margin: 0; padding-left: 16px; display: grid; gap: 6px; }
  b { color: var(--text); }
  .e { color: var(--danger); }
  @media (max-width: 1200px) { .prov { max-width: none; bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b)); } .prov .line span:first-child { max-width: 60vw; } }
  @media (max-width: 720px) { .prov { display: none; } }
</style>
