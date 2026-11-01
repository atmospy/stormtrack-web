<script lang="ts">
  import { CATEGORIES } from '#lib/util/storm';

  interface Pt { t: number; w: number }
  let { observed, forecast = [], label = 'Wind speed over time' }: { observed: Pt[]; forecast?: Pt[]; label?: string } = $props();

  const W = 300, H = 92, PL = 26, PR = 6, PT = 8, PB = 16;
  const all = $derived([...observed, ...forecast]);
  const tMin = $derived(Math.min(...all.map((p) => p.t)));
  const tMax = $derived(Math.max(...all.map((p) => p.t)));
  const wMax = $derived(Math.max(40, Math.ceil(Math.max(...all.map((p) => p.w)) / 20) * 20));
  const x = (t: number) => PL + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - PL - PR);
  const y = (w: number) => H - PB - (w / wMax) * (H - PT - PB);
  const path = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.w).toFixed(1)}`).join('');
  const thresholds = $derived([34, 64, 83, 96, 113, 137].filter((v) => v < wMax));
  const fmtD = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const lastObs = $derived(observed[observed.length - 1]);
</script>

{#if all.length >= 2}
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="{label}: {observed.length} observed and {forecast.length} forecast points, peak {Math.max(...all.map((p) => p.w))} knots">
    {#each thresholds as v, i (v)}
      <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke={CATEGORIES[i + 1]!.color} stroke-opacity=".28" stroke-dasharray="2 3" />
    {/each}
    <line x1={PL} x2={W - PR} y1={y(0)} y2={y(0)} stroke="var(--line-strong)" />
    <text x={PL - 4} y={y(0) + 3} text-anchor="end" class="ax">0</text>
    <text x={PL - 4} y={y(wMax) + 4} text-anchor="end" class="ax">{wMax}</text>
    <text x={PL} y={H - 3} class="ax">{fmtD(tMin)}</text>
    <text x={W - PR} y={H - 3} text-anchor="end" class="ax">{fmtD(tMax)}</text>
    {#if observed.length > 1}<path d={path(observed)} fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" />{/if}
    {#if forecast.length > 1 || (forecast.length && lastObs)}
      <path d={path(lastObs ? [lastObs, ...forecast] : forecast)} fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="2" stroke-dasharray="4 3" />
    {/if}
    {#if lastObs}<circle cx={x(lastObs.t)} cy={y(lastObs.w)} r="3.5" fill="var(--accent)" stroke="#fff" stroke-width="1.5" />{/if}
  </svg>
{/if}

<style>
  svg { width: 100%; height: auto; display: block; }
  .ax { fill: var(--text-faint); font-size: 9px; font-variant-numeric: tabular-nums; }
</style>
