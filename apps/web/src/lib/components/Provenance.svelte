<script lang="ts">
  import { app } from '#lib/stores/app.svelte';
  import { fmtAgo } from '#lib/util/storm';
  import { windRuntime } from '#lib/wind/runtime.svelte';

  let now = $state(Date.now());
  let open = $state(false);
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 30000);
    return () => clearInterval(id);
  });
  const w = $derived(app.wind);
  const run = $derived(w ? new Date(w.run).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC' : '');
  const runShort = $derived(w ? new Date(w.run).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', hour12: false }).replace(', ', ' ') + 'Z run' : '');
  const anySample = $derived(app.windSample || app.stormsSample || app.hazardsSample);
</script>

<footer class="prov">
  <button class="line glass tnum" onclick={() => (open = !open)} aria-expanded={open} aria-label="Data sources and provenance">
    {#if w}<span>{w.source} · {runShort} · {fmtAgo(w.generated, now)}</span>{:else}<span>Loading data…</span>{/if}
    {#if anySample}<span class="sample" title="Sample data in use: {[app.windSample && 'wind', app.stormsSample && 'storms', app.hazardsSample && 'hazards'].filter(Boolean).join(', ')}">SAMPLE</span>{/if}
  </button>
  {#if open}
    <div class="more glass" role="region" aria-label="Data sources">
      <h3>Data &amp; sources</h3>
      <ul>
        {#if w}<li><b>Wind</b> {w.level} · {w.source} · run {run}, generated {fmtAgo(w.generated, now)}. Licence: {w.licence || 'see source'}. Values are model output on a ~0.5° grid, not observations.{#if app.windSample} <i>Sample/synthetic data.</i>{/if}</li>{/if}
        <li><b>Cyclones</b> NHC / JTWC active systems{#if app.stormsUpdated}, updated {fmtAgo(app.stormsUpdated, now)}{/if}. Winds are 1-minute sustained. Historical tracks: IMD (3-minute winds) and IBTrACS.{#if app.stormsSample} <i>Sample data.</i>{/if}</li>
        <li><b>Events</b> NASA EONET · <b>Earthquakes</b> USGS · <b>Fires</b> NASA FIRMS{#if app.hazardsSample} <i>(sample data)</i>{/if}</li>
        <li><b>Basemap</b> <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a>, data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors. Place search: Nominatim (OSM) on request.</li>
        {#if windRuntime.error}<li class="e">Wind frame error: {windRuntime.error}</li>{/if}
      </ul>
    </div>
  {/if}
</footer>

<style>
  .prov { position: absolute; left: var(--gap); bottom: calc(var(--gap) + var(--safe-b)); z-index: 4; max-width: calc(50vw - 344px); }
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
