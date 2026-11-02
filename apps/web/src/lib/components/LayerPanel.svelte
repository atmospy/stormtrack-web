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

  type Row = { key: LayerKey; label: string; icon: 'wind' | 'storm' | 'history' | 'fire' | 'quake' | 'event' | 'bolt' | 'cloud'; hint: string; key_: string; group?: string };
  const rows: Row[] = [
    { key: 'wind', label: 'Weather', icon: 'wind', hint: 'wind, pressure, temperature, rain', key_: 'W' },
    { key: 'storms', label: 'Active cyclones', icon: 'storm', hint: '', key_: 'S' },
    { key: 'history', label: 'Storm history', icon: 'history', hint: 'all basins, filters', key_: 'H' },
    { key: 'events', label: 'Natural events', icon: 'event', hint: 'NASA EONET', key_: 'E' },
    { key: 'quakes', label: 'Earthquakes', icon: 'quake', hint: 'USGS 24 h', key_: 'Q' },
    { key: 'fires', label: 'Fire hotspots', icon: 'fire', hint: 'NASA FIRMS', key_: 'F' },
    { key: 'lightning', label: 'Lightning', icon: 'bolt', hint: 'GOES GLM Americas · IMD India', key_: 'G' },
    { key: 'clouds', label: 'Cloud imagery', icon: 'cloud', hint: 'GOES, Himawari infrared', key_: 'C' },
    { key: 'satellite', label: 'Satellite', icon: 'cloud', hint: 'INSAT infrared', key_: 'I', group: 'India · IMD' },
    { key: 'nowcast', label: 'District warnings', icon: 'event', hint: 'nowcast, valid ~3 h', key_: 'N', group: 'India · IMD' }
  ];
  function count(k: LayerKey): string {
    if (k === 'storms') return app.active ? String(app.active.features.filter((f) => f.properties.kind === 'position').length) : '';
    if (k === 'history') return history.enabled.length ? String(history.visible.length) : '';
    if (k === 'events' || k === 'quakes' || k === 'fires') {
      const n = app.hazardIndex?.layers[k]?.count;
      return n === undefined ? '' : String(n);
    }
    if (k === 'nowcast') return app.nowcast ? String(app.nowcast.features.length) : '';
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
      {#each rows as r, i (r.key)}
        {#if r.group && rows[i - 1]?.group !== r.group}<li class="grp" role="presentation">{r.group}</li>{/if}
        {@const a = app.availability[r.key]}
        {@const off = a === 'missing' || a === 'error'}
        <li>
          <label class:off title="{r.label} ({r.key_})">
            <input type="checkbox" role="switch" checked={app.layers[r.key]} disabled={off} onchange={() => app.toggle(r.key)} />
            <span class="sw" aria-hidden="true"></span>
            <span class="ic"><Icon name={r.icon} size={16} /></span>
            <span class="txt">
              <span class="nm">{r.label}</span>
              <span class="hint">{sub(r.key, r.hint)}</span>
            </span>
            {#if a === 'loading'}<span class="dot" title="Loading"></span>{:else if count(r.key)}<span class="n tnum">{count(r.key)}</span>{/if}
            
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
  .panel { position: absolute; top: calc(var(--gap) * 2 + 38px + env(safe-area-inset-top, 0px)); left: var(--gap); width: 256px; z-index: 4; overflow-x: hidden; overflow-y: auto; max-height: calc(100% - var(--timebar-h) - var(--dock-bottom) - 92px - env(safe-area-inset-top, 0px)); }
  .head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 14px 6px; background: none; border: 0; color: var(--text-faint); }
  .chev { margin-left: auto; transition: transform 0.2s; transform: rotate(-90deg); display: grid; }
  .chev.open { transform: none; }
  ul { list-style: none; margin: 0; padding: 2px 6px 6px; }
  .grp { margin: 8px 8px 2px; padding-top: 7px; border-top: 1px solid var(--line); font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint); }
  label { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 8px; cursor: pointer; position: relative; }
  label:hover { background: rgba(255, 255, 255, 0.045); }
  label.off { opacity: 0.45; cursor: not-allowed; }
  input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; cursor: inherit; }
  .sw { width: 24px; height: 14px; border-radius: 8px; background: rgba(255, 255, 255, 0.1); position: relative; flex: none; transition: background 0.2s; }
  .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: #8da2c9; transition: transform 0.2s, background 0.2s; }
  input:checked + .sw { background: rgba(111, 227, 255, 0.28); }
  input:checked + .sw::after { transform: translateX(10px); background: var(--accent); box-shadow: 0 0 8px rgba(111, 227, 255, 0.7); }
  input:focus-visible + .sw { outline: 2px solid var(--accent); outline-offset: 2px; }
  .ic { color: var(--text-faint); display: grid; transition: color 0.2s; }
  input:checked ~ .ic { color: var(--accent); }
  .txt { display: grid; min-width: 0; flex: 1; line-height: 1.2; }
  .nm { font-weight: 500; font-size: 13px; }
  .hint { font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-height: 0; opacity: 0; transition: max-height 0.2s, opacity 0.2s; }
  label:hover .hint, label.off .hint, label:focus-within .hint { max-height: 16px; opacity: 1; }
  .n { font-size: 11px; color: var(--text-faint); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: blink 1s infinite alternate; }
  @keyframes blink { to { opacity: 0.2; } }
  .sec { padding: 10px 14px 12px; border-top: 1px solid var(--line); }
  .wm { padding-top: 8px; padding-bottom: 8px; }
  .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; padding: 2px; background: rgba(255, 255, 255, 0.04); border-radius: 8px; }
  .seg button { border: 0; background: none; padding: 5px; border-radius: 6px; color: var(--text-faint); font-size: 12px; }
  .seg button.on { background: rgba(111, 227, 255, 0.13); color: var(--text); }
  .seg button:disabled { opacity: 0.5; cursor: not-allowed; }
  .cats { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .cat { display: inline-flex; align-items: center; gap: 5px; font-size: 10.5px; color: var(--text-faint); }
  .cat i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
  @media (max-width: 720px) { .panel { width: min(256px, calc(100vw - 2 * var(--gap))); } }
</style>
