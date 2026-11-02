<script lang="ts">
  import Legend from './Legend.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { gate } from '#lib/stores/gate.svelte';
  import { LEVEL_ORDER, VARIABLES, levelDescription, levelsOf, tempLevels, tempLevelShown, variablesOf } from '#lib/weather/select';

  const SHORT: Record<string, string> = { gfs: 'GFS', 'ecmwf-ifs': 'IFS', 'ecmwf-aifs': 'AIFS' };
  const models = $derived(app.catalogue.filter((e) => app.models[e.id]));
  const model = $derived(app.model);
  const vars = $derived(model ? VARIABLES.filter((v) => variablesOf(model).includes(v.id)) : []);
  const windLevels = $derived(model ? levelsOf(model) : []);
  const isTemp = $derived(app.variable === 'temperature');
  /** Temperature picks its own levels ("2 m" is the surface field); wind and the other fields use the wind levels. */
  const levels = $derived(isTemp && model ? tempLevels(model) : windLevels);
  const shown = $derived(isTemp && model ? tempLevelShown(model, app.level) : app.level);
  const showLevels = $derived(isTemp || app.variable === 'wind' || app.overlay);
  const levelName = (l: string) => (l === '10m' ? (isTemp ? '2 m' : '10 m') : l);
  const levelTitle = (l: string) => (l === '10m' && isTemp ? '2 m above ground' : levelDescription(l));
  const pick = (fn: () => void) => () => { fn(); gate.interact(); };
</script>

{#if model}
  <div class="fc" aria-label="Weather field">
    {#if models.length > 1}
      <div class="seg" role="group" aria-label="Forecast model">
        {#each models as e (e.id)}
          <button class:on={app.modelId === e.id} aria-pressed={app.modelId === e.id} title={e.name} onclick={pick(() => app.setModel(e.id))}>{SHORT[e.id] ?? e.id}</button>
        {/each}
      </div>
    {:else}
      <div class="one" title={model.licence}>{model.name}</div>
    {/if}

    <div class="seg v" role="group" aria-label="Variable">
      {#each vars as v (v.id)}
        <button class:on={app.variable === v.id} aria-pressed={app.variable === v.id} onclick={pick(() => app.setVariable(v.id))}>{v.label}</button>
      {/each}
    </div>

    {#if showLevels && levels.length > 1}
      <div class="lv" role="group" aria-label={isTemp ? 'Temperature level' : 'Wind level'}>
        {#each LEVEL_ORDER.filter((l) => levels.includes(l)) as l (l)}
          <button class:on={shown === l} aria-pressed={shown === l} title={levelTitle(l)} onclick={pick(() => app.setLevel(l))}>{levelName(l)}</button>
        {/each}
      </div>
      <div class="lvd tnum">{levelTitle(shown)}</div>
    {/if}

    {#if app.variable !== 'wind' && windLevels.length}
      <label class="ov"><input type="checkbox" bind:checked={app.overlay} /> Wind particles on top</label>
    {/if}

    <Legend />
  </div>
{/if}

<style>
  .fc { padding: 10px 14px 12px; border-top: 1px solid var(--line); display: grid; gap: 8px; }
  .one { font-size: 12px; color: var(--text-dim); }
  .seg { display: flex; gap: 3px; padding: 3px; background: rgba(255, 255, 255, 0.05); border-radius: 9px; }
  .seg button { flex: 1; border: 0; background: none; padding: 5px 4px; border-radius: 7px; color: var(--text-dim); font-size: 12px; white-space: nowrap; }
  .seg button.on { background: rgba(94, 224, 255, 0.16); color: var(--text); }
  .seg button:hover:not(.on) { color: var(--text); }
  .seg button:focus-visible, .lv button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .lv { display: flex; flex-wrap: wrap; gap: 4px; }
  .lv button { padding: 3px 9px; font-size: 12px; border-radius: 12px; border: 1px solid var(--line); background: none; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .lv button.on { border-color: var(--accent); color: var(--text); background: rgba(94, 224, 255, 0.14); }
  .lvd { font-size: 11.5px; color: var(--text-faint); margin-top: -3px; }
  .ov { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-dim); cursor: pointer; }
</style>
