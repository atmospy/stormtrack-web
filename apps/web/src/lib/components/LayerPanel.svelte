<script lang="ts">
  import Icon from './Icon.svelte';
  import { app, type LayerKey } from '#lib/stores/app.svelte';
  import { CATEGORIES } from '#lib/util/storm';
  import { gate } from '#lib/stores/gate.svelte';
  import { history } from '#lib/history/state.svelte';
  import FieldControl from './FieldControl.svelte';
  import LightningControls from './LightningControls.svelte';
  import HistoryControls from './HistoryControls.svelte';

  let open = $state(typeof matchMedia === 'undefined' || !matchMedia('(max-width: 720px)').matches);

  type Row = { key: LayerKey; label: string; icon: 'wind' | 'storm' | 'history' | 'fire' | 'quake' | 'event' | 'bolt'; hint: string; key_: string };
  const rows: Row[] = [
    { key: 'wind', label: 'Weather', icon: 'wind', hint: 'wind, pressure, temperature, rain', key_: 'W' },
    { key: 'storms', label: 'Active cyclones', icon: 'storm', hint: '', key_: 'S' },
    { key: 'history', label: 'Storm history', icon: 'history', hint: 'all basins, filters', key_: 'H' },
    { key: 'events', label: 'Natural events', icon: 'event', hint: 'NASA EONET', key_: 'E' },
    { key: 'quakes', label: 'Earthquakes', icon: 'quake', hint: 'USGS 24 h', key_: 'Q' },
    { key: 'fires', label: 'Fire hotspots', icon: 'fire', hint: 'NASA FIRMS', key_: 'F' },
    { key: 'lightning', label: 'Lightning', icon: 'bolt', hint: 'GOES GLM · Americas', key_: 'G' }
  ];
  function count(k: LayerKey): string {
    if (k === 'storms') return app.active ? String(app.active.features.filter((f) => f.properties.kind === 'position').length) : '';
    if (k === 'history') return history.enabled.length ? String(history.visible.length) : '';
    if (k === 'events' || k === 'quakes' || k === 'fires') {
      const n = app.hazardIndex?.layers[k]?.count;
      return n === undefined ? '' : String(n);
    }
    return '';
  }
  function sub(k: LayerKey, hint: string): string {
    const a = app.availability[k];
    if (a === 'missing') return app.notes[k] ?? 'No data available';
    if (a === 'error') return 'Data error, see console';
    return hint;
  }
</script>

<aside class="panel glass" aria-label="Layers">
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <Icon name="layers" size={16} /><span class="label">Layers</span>
    <span class="chev" class:open><Icon name="chevron" size={14} /></span>
  </button>
  {#if open}
    <ul>
      {#each rows as r (r.key)}
        {@const a = app.availability[r.key]}
        {@const off = a === 'missing' || a === 'error'}
        <li>
          <label class:off>
            <input type="checkbox" role="switch" checked={app.layers[r.key]} disabled={off} onchange={() => app.toggle(r.key)} />
            <span class="sw" aria-hidden="true"></span>
            <span class="ic"><Icon name={r.icon} size={16} /></span>
            <span class="txt">
              <span class="nm">{r.label}</span>
              <span class="hint">{sub(r.key, r.hint)}</span>
            </span>
            {#if a === 'loading'}<span class="dot" title="Loading"></span>{:else if count(r.key)}<span class="n tnum">{count(r.key)}</span>{/if}
            <kbd class="k">{r.key_}</kbd>
          </label>
        </li>
      {/each}
    </ul>
    {#if app.layers.wind && app.availability.wind === 'ready'}
      <FieldControl />
      <div class="sec wm">
        <div class="seg" role="group" aria-label="Wind display">
          <button class:on={app.windMode === 'particles' && !app.reducedMotion} disabled={app.reducedMotion} onclick={() => { app.windMode = 'particles'; gate.interact(); }}>Particles</button>
          <button class:on={app.windMode === 'arrows' || app.reducedMotion} onclick={() => { app.windMode = 'arrows'; gate.interact(); }}>Arrows</button>
        </div>
      </div>
    {/if}
    {#if app.layers.lightning}<LightningControls />{/if}
    {#if app.layers.history && history.index}<HistoryControls />{/if}
    {#if app.layers.storms || app.layers.history}
      <div class="sec">
        <div class="cats" title="Saffir-Simpson scale, 1-minute sustained wind">
          {#each CATEGORIES as c (c.rank)}<span class="cat tnum"><i style="background:{c.color}"></i>{c.label}</span>{/each}
        </div>
      </div>
    {/if}
  {/if}
</aside>

<style>
  .panel { position: absolute; top: calc(var(--gap) * 2 + 40px + env(safe-area-inset-top, 0px)); left: var(--gap); width: 284px; z-index: 4; overflow-x: hidden; overflow-y: auto; max-height: calc(100% - var(--timebar-h) - 100px - var(--gap) * 2); scrollbar-width: thin; }
  .head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; background: none; border: 0; color: var(--text-dim); }
  .chev { margin-left: auto; transition: transform 0.2s; transform: rotate(-90deg); display: grid; }
  .chev.open { transform: none; }
  ul { list-style: none; margin: 0; padding: 0 6px 6px; }
  label { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 10px; cursor: pointer; position: relative; }
  label:hover { background: rgba(255, 255, 255, 0.05); }
  label.off { opacity: 0.55; cursor: not-allowed; }
  input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; cursor: inherit; }
  .sw { width: 28px; height: 16px; border-radius: 9px; background: rgba(255, 255, 255, 0.12); position: relative; flex: none; transition: background 0.2s; }
  .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #cfe0ff; transition: transform 0.2s; }
  input:checked + .sw { background: linear-gradient(135deg, #1ec8f0, #6b6bff); box-shadow: var(--glow); }
  input:checked + .sw::after { transform: translateX(12px); background: #fff; }
  input:focus-visible + .sw { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ic { color: var(--accent); display: grid; }
  .txt { display: grid; min-width: 0; flex: 1; line-height: 1.2; }
  .nm { font-weight: 550; }
  .hint { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .n { font-size: 11.5px; color: var(--text-dim); background: rgba(255, 255, 255, 0.06); padding: 1px 7px; border-radius: 8px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: blink 1s infinite alternate; }
  @keyframes blink { to { opacity: 0.2; } }
  .k { opacity: 0.6; }
  .sec { padding: 10px 14px 12px; border-top: 1px solid var(--line); }
  .wm { padding-top: 8px; padding-bottom: 8px; }
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; padding: 3px; background: rgba(255, 255, 255, 0.05); border-radius: 9px; }
  .seg button { border: 0; background: none; padding: 5px; border-radius: 7px; color: var(--text-dim); font-size: 12px; }
  .seg button.on { background: rgba(94, 224, 255, 0.16); color: var(--text); }
  .seg button:disabled { opacity: 0.5; cursor: not-allowed; }
  .cats { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .cat { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }
  .cat i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  @media (max-width: 720px) { .panel { width: min(284px, calc(100vw - 2 * var(--gap))); } .k { display: none; } }
</style>
