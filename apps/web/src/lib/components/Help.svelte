<script lang="ts">
  import { app } from '#lib/stores/app.svelte';
  const rows: [string, string][] = [
    ['⌘/Ctrl K', 'Command palette'], ['Space', 'Play / pause forecast'], ['← →', 'Step forecast frame'], ['W', 'Wind'], ['S', 'Active cyclones'], ['H', 'Historical tracks'],
    ['E', 'Natural events'], ['Q', 'Earthquakes'], ['F', 'Fire hotspots'], ['G', 'Lightning'], ['M', 'Thunder sound on/off (lightning)'], ['L', 'Use my location'], ['Esc', 'Close panel / dialog'], ['?', 'This help']
  ];
</script>
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={() => (app.helpOpen = false)}>
  <div class="m glass" role="dialog" tabindex="-1" aria-modal="true" aria-label="Keyboard shortcuts" onclick={(e) => e.stopPropagation()}>
    <h2>Keyboard shortcuts</h2>
    <dl>{#each rows as [k, d] (k)}<dt><kbd>{k}</kbd></dt><dd>{d}</dd>{/each}</dl>
    <p class="sw">Page stuck or out of date? <a href="?sw=0">Reset the app cache (safe mode)</a></p>
  </div>
</div>
<style>
  .scrim { position: fixed; inset: 0; background: rgba(2, 5, 12, 0.55); z-index: 55; display: grid; place-items: center; padding: 12px; }
  .m { padding: 20px 24px; background: var(--glass-strong); }
  h2 { margin: 0 0 12px; font-size: 17px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 18px; margin: 0; }
  dd { margin: 0; color: var(--text-dim); }
  dt { text-align: right; }
  .sw { margin: 14px 0 0; font-size: 12px; color: var(--text-faint); }
</style>
