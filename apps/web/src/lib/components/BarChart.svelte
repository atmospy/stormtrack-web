<script lang="ts">
  let { data, highlight = null, label = '' }: { data: { year: number; value: number }[]; highlight?: number | null; label?: string } = $props();
  const W = 300, H = 90, PL = 20, PB = 14, PT = 6;
  const max = $derived(Math.max(1, ...data.map((d) => d.value)));
  const bw = $derived((W - PL) / Math.max(1, data.length));
  let hover = $state<number | null>(null);
  const avg = $derived(data.length ? data.reduce((a, d) => a + d.value, 0) / data.length : 0);
</script>

{#if data.length}
  <svg viewBox="0 0 {W} {H}" role="img" aria-label={label}>
    <line x1={PL} x2={W} y1={H - PB} y2={H - PB} stroke="var(--line-strong)" />
    <line x1={PL} x2={W} y1={H - PB - (avg / max) * (H - PB - PT)} y2={H - PB - (avg / max) * (H - PB - PT)} stroke="var(--accent)" stroke-opacity=".5" stroke-dasharray="3 3" />
    {#each data as d, i (d.year)}
      {@const h = (d.value / max) * (H - PB - PT)}
      <rect
        x={PL + i * bw + 0.5} y={H - PB - h} width={Math.max(1, bw - 1.5)} height={h} rx="1"
        fill={d.year === highlight ? '#ffb03b' : hover === i ? '#fff' : 'var(--accent)'} fill-opacity={d.year === highlight || hover === i ? 1 : 0.55}
        role="presentation" onmouseenter={() => (hover = i)} onmouseleave={() => (hover = null)}
      ><title>{d.year}: {d.value}</title></rect>
    {/each}
    <text x={PL - 3} y={H - PB + 3} text-anchor="end" class="ax">0</text>
    <text x={PL - 3} y={PT + 6} text-anchor="end" class="ax">{max}</text>
    <text x={PL} y={H - 2} class="ax">{data[0]!.year}</text>
    <text x={W} y={H - 2} text-anchor="end" class="ax">{data[data.length - 1]!.year}</text>
    {#if hover !== null}<text x={W} y={PT + 6} text-anchor="end" class="hv">{data[hover]!.year}: {data[hover]!.value}</text>{/if}
  </svg>
  <div class="avg tnum">mean {avg.toFixed(1)} per year{#if highlight !== null}, <span class="hl">highlighted: {highlight}</span>{/if}</div>
{/if}

<style>
  svg { width: 100%; height: auto; display: block; }
  .ax { fill: var(--text-faint); font-size: 9px; font-variant-numeric: tabular-nums; }
  .hv { fill: var(--text); font-size: 10px; font-variant-numeric: tabular-nums; }
  .avg { font-size: 11px; color: var(--text-faint); margin-top: 2px; }
  .hl { color: var(--warn); }
</style>
