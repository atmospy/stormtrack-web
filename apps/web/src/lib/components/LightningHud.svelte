<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { lightning } from '#lib/lightning/state.svelte';
  import { meteo } from '#lib/weather/meteo.svelte';
  import { feedBadge } from '#lib/lightning/status';

  const badge = $derived(feedBadge(lightning.feed, lightning.delayS));
  const armed = $derived(lightning.soundPref && !lightning.soundActive);
  const listener = $derived(meteo.point ? 'pinned place' : 'view centre');
  const speakerLabel = $derived(lightning.soundActive ? 'Mute thunder (M)' : armed ? 'Sound was on last time: click to start thunder (M)' : 'Turn on thunder sound (M)');
</script>

{#if app.layers.lightning}
  <div class="hud glass" role="group" aria-label="Lightning live status and sound">
    <span class="badge {badge.tone}" title={badge.title}><i class="dot" aria-hidden="true"></i><span>{badge.text}</span></span>
    <button class="spk" class:on={lightning.soundActive} class:armed onclick={() => lightning.toggleSound()} aria-pressed={lightning.soundActive} aria-label={speakerLabel} title={speakerLabel}>
      <Icon name={lightning.soundActive ? 'speaker' : 'speaker-off'} size={17} />
    </button>
    {#if lightning.soundActive}
      <input class="vol" type="range" min="0" max="1" step="0.05" value={lightning.volume} oninput={(e) => lightning.setVolume(+e.currentTarget.value)} aria-label="Thunder volume" />
      <span class="hint" title="Thunder loudness, sharpness and delay depend on the distance from the listener point to each strike. Pin a place (click the map) to listen from there.">listener: {listener}</span>
    {:else if armed}
      <span class="hint">click to resume sound</span>
    {/if}
  </div>
  <!-- rate-limited summary for screen readers (not one message per strike) -->
  <div class="sr" role="status" aria-live="polite" aria-atomic="true">{lightning.announce}</div>
{/if}

<style>
  .hud { position: absolute; top: calc(var(--gap) * 2 + 40px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); z-index: 4; display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 10px; border-radius: 12px; max-width: calc(100vw - 2 * var(--gap)); }
  .badge { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 600; letter-spacing: 0.01em; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
  .badge.live { color: #3de0b0; }
  .badge.live .dot { animation: pulse 1.8s ease-in-out infinite; }
  .badge.demo { color: #c4b5ff; }
  .badge.stale { color: var(--warn); }
  .badge.offline, .badge.missing { color: #ff8896; }
  .badge.connecting { color: var(--text-dim); }
  .spk { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 9px; border: 1px solid var(--line); background: rgba(255, 255, 255, 0.05); color: var(--text-dim); padding: 0; }
  .spk:hover { border-color: var(--line-strong); color: var(--text); }
  .spk.on { color: #ffd24a; border-color: rgba(255, 210, 74, 0.5); background: rgba(255, 210, 74, 0.12); }
  .spk.armed { border-color: var(--accent); color: var(--accent); }
  .spk:focus-visible, .vol:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .vol { width: 84px; accent-color: #ffd24a; }
  .hint { font-size: 11px; color: var(--text-dim); white-space: nowrap; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @keyframes pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { .badge.live .dot { animation: none; } }
  @media (max-width: 900px) {
    .hud { top: auto; bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b) + 2px); left: var(--gap); transform: none; }
    .hint { display: none; }
  }
</style>
