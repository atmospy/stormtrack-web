<script lang="ts">
  /** Headless: mirrors view state into the query string with replaceState (no history entries), debounced. */
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { currentShareState } from '#lib/state/share.svelte';
  import { serialize } from '#lib/state/url';
  import { meteo } from '#lib/weather/meteo.svelte';
  import { meteoPinned } from '#lib/weather/meteo.svelte';

  let ready = $state(false);
  onMount(() => {
    // do not overwrite the URL we were opened with until boot has applied it
    const id = setTimeout(() => (ready = true), 1500);
    return () => clearTimeout(id);
  });

  $effect(() => {
    if (!ready) return;
    const q = serialize(currentShareState(meteoPinned.point ?? meteo.point));
    const id = setTimeout(() => {
      try {
        const url = `${location.pathname}${q ? '?' + q : ''}${location.hash}`;
        if (url !== location.pathname + location.search + location.hash) void goto(url, { replace: true, shallow: true, state: {} });
      } catch {
        /* sandboxed iframes can forbid replaceState */
      }
    }, 350);
    return () => clearTimeout(id);
  });
</script>
