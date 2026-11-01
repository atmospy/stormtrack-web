<script lang="ts">
  import { onMount } from 'svelte';
  import MapView from '#lib/components/MapView.svelte';
  import TopBar from '#lib/components/TopBar.svelte';
  import LayerPanel from '#lib/components/LayerPanel.svelte';
  import TimeBar from '#lib/components/TimeBar.svelte';
  import Readout from '#lib/components/Readout.svelte';
  import Conditions from '#lib/components/Conditions.svelte';
  import StormPanel from '#lib/components/StormPanel.svelte';
  import Provenance from '#lib/components/Provenance.svelte';
  import Toasts from '#lib/components/Toasts.svelte';
  import SignupCard from '#lib/components/SignupCard.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { gate } from '#lib/stores/gate.svelte';
  import { auth } from '#lib/auth/auth.svelte';
  import { bootData } from '#lib/data/boot';
  import { groupStorms, stormBounds } from '#lib/data/active';
  import { toast } from '#lib/stores/toast.svelte';
  import { windRuntime } from '#lib/wind/runtime.svelte';

  // heavy/rare UI is code-split
  const Palette = () => import('#lib/components/CommandPalette.svelte');
  const Auth = () => import('#lib/components/AuthModal.svelte');
  const Help = () => import('#lib/components/Help.svelte');

  onMount(() => {
    const ac = new AbortController();
    if (import.meta.env.DEV) { (window as any).__app = app; (window as any).__wr = windRuntime; }
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    app.reducedMotion = mq.matches;
    const onMq = () => (app.reducedMotion = mq.matches);
    mq.addEventListener('change', onMq);
    const stopGate = gate.start();
    auth.init();
    void bootData(ac.signal).then(() => {
      // intro: fly to the strongest active storm, if any
      if (!app.active) return;
      const storms = [...groupStorms(app.active).values()].sort((a, b) => (b.position.properties.wind_kt ?? 0) - (a.position.properties.wind_kt ?? 0));
      if (storms[0]) setTimeout(() => app.flyToBounds(stormBounds(storms[0]!)), 700);
    });
    return () => {
      ac.abort();
      mq.removeEventListener('change', onMq);
      stopGate();
    };
  });

  $effect(() => gate.setSignedIn(auth.signedIn));

  function onkeydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing = t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      app.paletteOpen = !app.paletteOpen;
      return;
    }
    if (e.key === 'Escape') {
      if (app.helpOpen) app.helpOpen = false;
      else if (app.authOpen) app.authOpen = false;
      else if (app.selection) app.select(null);
      else if (app.readout?.pinned) app.readout = null;
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || app.paletteOpen || app.authOpen) return;
    const k = e.key.toLowerCase();
    const layerKeys: Record<string, Parameters<typeof app.toggle>[0]> = { w: 'wind', s: 'storms', h: 'history', e: 'events', q: 'quakes', f: 'fires' };
    if (k in layerKeys) app.toggle(layerKeys[k]!);
    else if (k === ' ' && t?.tagName !== 'BUTTON') { e.preventDefault(); app.playing = !app.playing; }
    else if (k === 'arrowright' && t?.tagName !== 'INPUT') { app.playing = false; app.scrubTo(app.frameIdx + 1); gate.interact(); }
    else if (k === 'arrowleft' && t?.tagName !== 'INPUT') { app.playing = false; app.scrubTo(app.frameIdx - 1); gate.interact(); }
    else if (k === '?') app.helpOpen = !app.helpOpen;
    else if (k === 'l') {
      navigator.geolocation?.getCurrentPosition(
        (p) => { app.userLocation = { lon: p.coords.longitude, lat: p.coords.latitude }; app.flyTo(p.coords.longitude, p.coords.latitude, 5); },
        () => toast.show('Could not get your location', 'warn'),
        { timeout: 8000 }
      );
    }
  }
</script>

<svelte:window {onkeydown} />
<svelte:head><title>StormTrack: live wind, cyclones and hazards</title></svelte:head>

<main>
  <MapView />
  <TopBar />
  <LayerPanel />
  <Conditions />
  <StormPanel />
  <Readout />
  <TimeBar />
  <Provenance />
  {#if gate.show && !app.authOpen}<SignupCard />{/if}
  <Toasts />
  {#if app.paletteOpen}{#await Palette() then m}<m.default />{/await}{/if}
  {#if app.authOpen}{#await Auth() then m}<m.default />{/await}{/if}
  {#if app.helpOpen}{#await Help() then m}<m.default />{/await}{/if}
</main>

<style>
  main { position: fixed; inset: 0; overflow: hidden; }
</style>
