<script lang="ts">
  import { app } from '#lib/stores/app.svelte';
  import { gate } from '#lib/stores/gate.svelte';
  import { history, stormsNear } from '#lib/history/state.svelte';
  import { CATEGORIES } from '#lib/util/storm';
  import { BASIN_NAMES, SEASONAL_BASINS, seasonLabel } from '#lib/data/history';

  const [rMin, rMax] = $derived(history.range);
  const [y0, y1] = $derived(history.yearsEffective);
  const shown = $derived(history.visible.length);
  const near = $derived(history.near && history.point ? stormsNear(history.visible, history.point.lon, history.point.lat, history.nearKm) : []);
  const anyLoading = $derived(Object.values(history.loading).some(Boolean));
  const setYears = (a: number, b: number) => { history.years = a <= b ? [a, b] : [b, a]; };
  const fmtCoord = (p: { lon: number; lat: number }) => `${Math.abs(p.lat).toFixed(1)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(1)}°${p.lon >= 0 ? 'E' : 'W'}`;
</script>

<div class="hc" aria-label="Storm history filters">
  <div class="chips" role="group" aria-label="Basins">
    {#each history.entries as e (e.code)}
      {@const on = history.enabled.includes(e.code)}
      <button class:on aria-pressed={on} title="{e.name ?? BASIN_NAMES[e.code]} · {e.count.toLocaleString('en-US')} storms · {e.year_min}-{e.year_max}{e.gzip_bytes ? ' · ' + Math.round(e.gzip_bytes / 1024) + ' kB download' : ''}" onclick={() => { history.toggleBasin(e.code); gate.interact(); }}>
        {e.code}{#if history.loading[e.code]}<i class="spin"></i>{/if}
      </button>
    {/each}
  </div>
  <div class="cnt tnum" role="status">{shown.toLocaleString('en-US')} storms shown{#if anyLoading} · loading…{/if}{#if Object.keys(history.failed).length} · <span class="e" title={JSON.stringify(history.failed)}>some basins failed to load</span>{/if}</div>

  <div class="yr">
    <span class="lab">Years <b class="tnum">{y0}–{y1}</b></span>
    <div class="two">
      <input type="range" min={rMin} max={rMax} value={y0} aria-label="First year" oninput={(e) => setYears(+e.currentTarget.value, y1)} />
      <input type="range" min={rMin} max={rMax} value={y1} aria-label="Last year" oninput={(e) => setYears(y0, +e.currentTarget.value)} />
    </div>
  </div>

  {#if history.enabled.some((b) => SEASONAL_BASINS.includes(b))}<div class="cnt">Southern-hemisphere basins (SI, SP, SA) use July-June seasons, labelled by the year they end.</div>{/if}
  <div class="mc">
    <span class="lab">Peak intensity at least</span>
    <div class="cats" role="group" aria-label="Minimum category">
      {#each CATEGORIES as c (c.rank)}
        <button class:on={history.minCategory === c.rank} aria-pressed={history.minCategory === c.rank} style="--c:{c.color}" title={c.name} onclick={() => (history.minCategory = c.rank)}><i></i>{c.label}</button>
      {/each}
    </div>
  </div>

  <label class="nr">
    <input type="checkbox" bind:checked={history.near} />
    Highlight storms near the clicked point
  </label>
  {#if history.near}
    {#if history.point}
      <div class="cnt tnum">{near.length} storm{near.length === 1 ? '' : 's'} passed within <b>{history.nearKm} km</b> of {fmtCoord(history.point)}</div>
      <input type="range" min="100" max="1000" step="50" bind:value={history.nearKm} aria-label="Radius in kilometres" />
      <ul class="nl">
        {#each [...near].sort((a, b) => (b.properties.max_wind_kt ?? 0) - (a.properties.max_wind_kt ?? 0)).slice(0, 5) as f (f.properties.id)}
          <li><button onclick={() => app.select({ type: 'history', id: f.properties.id })}>{f.properties.name ?? f.properties.id} <span class="tnum">{seasonLabel(f.properties.year, f.properties.basin)} · {f.properties.max_wind_kt ?? '?'} kt</span></button></li>
        {/each}
      </ul>
    {:else}
      <div class="cnt">Click the map to choose a point.</div>
    {/if}
  {/if}
</div>

<style>
  .hc { padding: 10px 14px 12px; border-top: 1px solid var(--line); display: grid; gap: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chips button { padding: 3px 9px; font-size: 12px; border-radius: 12px; border: 1px solid var(--line); background: none; color: var(--text-dim); position: relative; }
  .chips button.on { border-color: var(--accent); color: var(--text); background: rgba(94, 224, 255, 0.14); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .spin { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-left: 5px; animation: b 0.8s infinite alternate; }
  @keyframes b { to { opacity: 0.2; } }
  .cnt { font-size: 11.5px; color: var(--text-faint); }
  .e { color: var(--danger); }
  .lab { font-size: 11px; color: var(--text-dim); display: flex; justify-content: space-between; }
  .lab b { color: var(--text); }
  .two { display: grid; gap: 0; }
  input[type='range'] { width: 100%; accent-color: #36d9ff; margin: 2px 0; }
  .cats { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 4px; }
  .cats button { padding: 2px 7px; font-size: 11px; border-radius: 10px; border: 1px solid var(--line); background: none; color: var(--text-dim); display: inline-flex; align-items: center; gap: 4px; }
  .cats i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
  .cats button.on { border-color: var(--c); color: var(--text); background: color-mix(in srgb, var(--c) 16%, transparent); }
  .nr { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-dim); cursor: pointer; }
  .nl { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .nl button { width: 100%; text-align: left; background: none; border: 0; color: var(--text); font-size: 12px; padding: 3px 4px; border-radius: 6px; display: flex; justify-content: space-between; gap: 8px; }
  .nl button:hover { background: rgba(255, 255, 255, 0.06); }
  .nl span { color: var(--text-faint); }
</style>
