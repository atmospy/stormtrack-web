<script lang="ts">
  import Icon from './Icon.svelte';
  import WindArrow from './WindArrow.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { auth } from '#lib/auth/auth.svelte';
  import { toast } from '#lib/stores/toast.svelte';
  import { gate } from '#lib/stores/gate.svelte';
  import { meteo } from '#lib/weather/meteo.svelte';
  import { MS_TO_KT, compass, msToKmh } from '#lib/util/storm';

  const r = $derived(app.readout);
  const fmt = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;

  async function save() {
    if (!r) return;
    const res = await auth.savePlace(`${r.lat.toFixed(2)}, ${r.lon.toFixed(2)}`, r.lat, r.lon);
    if (res.ok) toast.show('Place saved');
    else if (res.reason === 'signed-out') app.authOpen = true;
    else toast.show(res.message, 'warn');
  }
  function use() {
    if (!r) return;
    app.userLocation = { lon: r.lon, lat: r.lat };
    gate.interact();
  }
</script>

{#if r}
  <div class="ro glass tnum" class:pinned={r.pinned} class:withmg={meteo.point !== null} role="status" aria-live={r.pinned ? 'polite' : 'off'}>
    <div class="coords">{fmt(r.lat, 'N', 'S')} {fmt(r.lon, 'E', 'W')}</div>
    {#if r.scalar != null && app.primary?.kind === 'scalar'}
      <div class="wind"><b>{r.scalar.toFixed(app.variable === 'precipitation' ? 1 : app.variable === 'temperature' ? 1 : 0)}</b><small>{app.primary.units}</small></div>
    {/if}
    {#if r.sample}
      <div class="wind">
        <WindArrow deg={r.sample.deg} size={22} />
        <b>{r.sample.speed.toFixed(1)}</b><small>m/s</small>
        <span class="sub">{(r.sample.speed * MS_TO_KT).toFixed(0)} kt · {msToKmh(r.sample.speed).toFixed(0)} km/h · from {compass(r.sample.deg)} {r.sample.deg.toFixed(0)}°</span>
      </div>
      <div class="note">model wind, {app.level === '10m' ? '10 m' : app.level + ' hPa'}</div>
    {:else}
      <div class="note">No wind data here</div>
    {/if}
    {#if r.pinned}
      <div class="acts">
        <button class="btn" onclick={save}><Icon name="pin" size={14} />Save place</button>
        <button class="btn ghost" onclick={use}>Conditions here</button>
        <button class="btn ghost icon" onclick={() => (app.readout = null)} aria-label="Dismiss readout"><Icon name="close" size={14} /></button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .ro { position: absolute; left: var(--gap); bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b) + 22px); padding: 10px 14px; min-width: 210px; z-index: 3; pointer-events: none; }
  .ro.withmg { display: none; }
  .ro.pinned { pointer-events: auto; border-color: var(--line-strong); }
  .coords { font-size: 12px; color: var(--text-dim); letter-spacing: 0.04em; }
  .wind { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  .wind :global(svg) { align-self: center; }
  b { font-size: 22px; font-weight: 700; }
  small { color: var(--text-dim); }
  .sub { flex-basis: 100%; font-size: 12px; color: var(--text-dim); }
  .note { font-size: 10.5px; color: var(--text-faint); margin-top: 4px; }
  .acts { display: flex; gap: 6px; margin-top: 8px; }
  .acts .btn { padding: 5px 10px; font-size: 12px; }
  .acts .icon { padding: 5px; width: 28px; height: 28px; }
  @media (max-width: 720px) { .ro:not(.pinned), .ro.withmg { display: none; } .ro { bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b)); } }
</style>
