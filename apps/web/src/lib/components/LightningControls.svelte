<script lang="ts">
  import { app } from '#lib/stores/app.svelte';
  import { gate } from '#lib/stores/gate.svelte';
  import { lightning, OUTSIDE_NOTICE } from '#lib/lightning/state.svelte';
  import { fmtAgo } from '#lib/util/storm';

  const wins = [5, 15, 60] as const;
  const b = $derived(lightning.bundle);
  const fmt = (n: number) => n.toLocaleString('en-US');
  const updatedAgo = $derived(b ? fmtAgo(b.index.updated, lightning.nowMs) : '');
</script>

<div class="lc" aria-label="Lightning">
  {#if lightning.availability === 'loading'}
    <div class="n">Loading lightning…</div>
  {:else if lightning.availability !== 'ready' || !b}
    <div class="n">Lightning feed unavailable right now.</div>
  {:else}
    <div class="big tnum" role="status" aria-live="polite"><b>{fmt(lightning.count10)}</b> flashes in the last 10 min</div>
    <div class="seg" role="group" aria-label="Lightning time window">
      {#each wins as w (w)}
        <button class:on={lightning.window === w} aria-pressed={lightning.window === w} onclick={() => { lightning.window = w; lightning.tick(); gate.interact(); }}>{w} min</button>
      {/each}
    </div>
    <div class="age tnum">
      Showing {fmt(lightning.countWindow)} in the last {lightning.window} min · data {updatedAgo}
      {#if lightning.stale}<span class="stale" title="The producer could not fetch new data and kept the previous files">STALE</span>{/if}
    </div>
    {#if b.index.keepFraction < 1}<div class="n" title="The feed was capped at 100 000 flashes by keeping a uniform pseudo-random subset">Sampled: about {Math.round(b.index.keepFraction * 100)}% of detected flashes are shown (counts are of the sample).</div>{/if}
    {#if b.warnings.length}<div class="warn">{b.warnings.join('; ')}</div>{/if}
    {#if (lightning.ageMin ?? 0) > 30 && !b.sample}<div class="notice" role="note">The feed was last updated {updatedAgo}. Flashes older than the selected window are not drawn, so an old feed shows none.</div>{/if}
    {#if lightning.insideCoverage === false}
      <div class="notice" role="note">{OUTSIDE_NOTICE} <button class="lnk" onclick={() => app.flyTo(-85, 25, 3)}>Show covered area</button></div>
    {/if}
    {#each lightning.visibleSources as v (v.s.id)}
      <div class="src">
        <b>{v.s.name}</b>{#if v.s.unofficial} <span class="unof" title="Not an official or warning-grade feed">unofficial feed</span>{/if}{#if v.s.stale} <span class="stale">STALE</span>{/if}
        <span class="tnum">{v.n.toLocaleString('en-US')} in view</span>
        <div class="n">{v.s.attribution}{#if v.s.time_precision === 'bucketed'} · times are bucketed{v.s.time_uncertainty_s ? ` (±${v.s.time_uncertainty_s} s)` : ''}, shown as an age fade only{/if}</div>
      </div>
    {:else}
      <div class="n">{b.index.sources.map((s) => s.name).join(', ')}. No strikes in view for the chosen window.</div>
    {/each}
    <div class="n">Dashed outline: where each source can see lightning (approximate).{#if b.sample} <i>Sample data.</i>{/if}</div>
  {/if}
</div>

<style>
  .lc { padding: 10px 14px 12px; border-top: 1px solid var(--line); display: grid; gap: 7px; }
  .big { font-size: 13px; color: var(--text-dim); }
  .big b { font-size: 20px; color: #ffd24a; font-weight: 700; }
  .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; background: rgba(255, 255, 255, 0.05); border-radius: 9px; }
  .seg button { border: 0; background: none; padding: 5px; border-radius: 7px; color: var(--text-dim); font-size: 12px; }
  .seg button.on { background: rgba(255, 210, 74, 0.18); color: var(--text); }
  .seg button:focus-visible, .lnk:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .age { font-size: 11.5px; color: var(--text-dim); }
  .stale { color: #04101c; background: var(--warn); font-weight: 700; font-size: 10px; letter-spacing: 0.08em; padding: 1px 6px; border-radius: 6px; margin-left: 4px; }
  .warn { font-size: 11.5px; color: var(--warn); }
  .notice { font-size: 12px; color: var(--text); background: rgba(255, 176, 59, 0.08); border: 1px solid rgba(255, 176, 59, 0.3); padding: 7px 9px; border-radius: 9px; }
  .lnk { background: none; border: 0; color: var(--accent); padding: 0; text-decoration: underline; font-size: 12px; }
  .n { font-size: 11.5px; color: var(--text-faint); }
  .src { font-size: 12px; color: var(--text-dim); }
  .src b { color: var(--text); font-weight: 600; }
  .unof { color: var(--warn); border: 1px solid rgba(255, 176, 59, 0.45); border-radius: 6px; padding: 0 5px; font-size: 10.5px; margin-left: 2px; }
  .src .tnum { margin-left: 6px; }
</style>
