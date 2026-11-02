<script lang="ts">
  import { app } from '#lib/stores/app.svelte';
  import { WIND_RAMP } from '#lib/wind/adapter';
  import { rampFor, type ScalarRamp } from '#lib/scalar/adapter';

  let ramp = $state.raw<ScalarRamp | null>(null);
  const scalar = $derived(app.primary && app.primary.kind === 'scalar' ? app.primary : null);

  $effect(() => {
    const v = app.variable;
    const lv = app.level;
    if (v === 'wind') {
      ramp = null;
      return;
    }
    let live = true;
    void rampFor(v, lv).then((r) => live && (ramp = r)).catch(() => {});
    return () => (live = false);
  });

  /** 1/2/5 x 10^n step at or above `raw` so tick labels are round numbers */
  function niceStep(raw: number): number {
    const p = 10 ** Math.floor(Math.log10(raw || 1));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  /** gradient + ticks over the ramp's own value domain, clipped to the field's range */
  const grad = $derived.by(() => {
    if (!ramp || !scalar) return null;
    const stops = ramp.stops;
    const lo = Math.max(stops[0]![0], scalar.range[0]);
    const hi = Math.min(stops[stops.length - 1]![0], scalar.range[1]);
    const span = hi - lo || 1;
    const css = stops.filter(([v]) => v >= lo && v <= hi).map(([v, c]) => `${c} ${(((v - lo) / span) * 100).toFixed(1)}%`).join(',');
    const step = niceStep(span / 5);
    const ticks: { v: number; pct: number }[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push({ v, pct: ((v - lo) / span) * 100 });
    return { css, ticks };
  });
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(1)).toString());
</script>

{#if app.variable === 'wind'}
  <div class="ramp" style="background: linear-gradient(90deg, {WIND_RAMP.map(([s, c]) => `${c} ${(s / 40) * 100}%`).join(',')})" role="img" aria-label="Wind speed colour scale, 0 to 40 metres per second"></div>
  <div class="ticks tnum"><span>0</span><span>10</span><span>20</span><span>30</span><span>40+ m/s</span></div>
{:else if grad}
  <div class="ramp checker"><div style="background: linear-gradient(90deg, {grad.css}); height: 100%"></div></div>
  <div class="ticks pos tnum" aria-hidden="true">{#each grad.ticks as t, i (i)}<span style="left: {t.pct}%">{fmt(t.v)}</span>{/each}</div>
  <div class="unit tnum">{scalar?.units}{scalar?.transform === 'sqrt' ? ' (colour scale is not linear)' : ''}</div>
{:else}
  <div class="ramp skel"></div>
{/if}

<style>
  .ramp { height: 8px; border-radius: 4px; overflow: hidden; }
  .checker { background: repeating-conic-gradient(rgba(255,255,255,0.1) 0% 25%, transparent 0% 50%) 0 0 / 8px 8px; }
  .skel { background: rgba(255, 255, 255, 0.08); }
  .ticks { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--text-faint); margin-top: 4px; }
  .ticks.pos { display: block; position: relative; height: 14px; }
  .ticks.pos span { position: absolute; transform: translateX(-50%); }
  .unit { font-size: 10.5px; color: var(--text-faint); margin-top: 2px; }
</style>
