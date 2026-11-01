<script lang="ts">
  import Icon from './Icon.svelte';
  import WindArrow from './WindArrow.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { weather } from '#lib/weather/runtime.svelte';
  import { CITIES } from '#lib/data/cities';
  import { MS_TO_KT, beaufort, compass, distBearing, msToKmh } from '#lib/util/storm';
  import { toast } from '#lib/stores/toast.svelte';

  const loc = $derived(app.userLocation ?? app.center);
  const isUser = $derived(app.userLocation !== null);
  const s = $derived((weather.wind, weather.sampleWind(loc.lon, loc.lat)));
  const place = $derived.by(() => {
    let best: { name: string; km: number } | null = null;
    for (const c of CITIES) {
      const d = distBearing(loc.lon, loc.lat, c.lon, c.lat).km;
      if (!best || d < best.km) best = { name: c.name, km: d };
    }
    return best && best.km < 400 ? `Near ${best.name}` : null;
  });
  const nearest = $derived.by(() => {
    if (!app.active) return null;
    let best: { name: string; km: number; bearing: number } | null = null;
    for (const f of app.active.features) {
      if (f.properties.kind !== 'position') continue;
      const [lo, la] = f.geometry.coordinates as [number, number];
      const d = distBearing(loc.lon, loc.lat, lo, la);
      if (!best || d.km < best.km) best = { name: f.properties.name ?? f.properties.id, km: d.km, bearing: d.bearing };
    }
    return best;
  });
  let open = $state(true);

  function locate() {
    if (!('geolocation' in navigator)) return toast.show('Geolocation is not available', 'warn');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        app.userLocation = { lon: p.coords.longitude, lat: p.coords.latitude };
        app.flyTo(p.coords.longitude, p.coords.latitude, 5);
      },
      () => toast.show('Could not get your location (permission denied?)', 'warn'),
      { timeout: 8000, maximumAge: 600000 }
    );
  }
  $effect(() => {
    if (app.selection) open = false;
  });
</script>

{#if app.weatherReady}
  <section class="card glass" aria-label="Current conditions" class:hidden={app.selection !== null && !open}>
    <header>
      <span class="label">{isUser ? 'Your location' : 'View centre'}</span>
      <button class="btn ghost icon" onclick={locate} aria-label="Use my location" title="Use my location"><Icon name="locate" size={15} /></button>
      {#if isUser}<button class="btn ghost icon" onclick={() => (app.userLocation = null)} aria-label="Back to view centre"><Icon name="close" size={14} /></button>{/if}
    </header>
    {#if s}
      {@const bf = beaufort(s.speed)}
      <div class="main">
        <WindArrow deg={s.deg} size={44} />
        <div>
          <div class="spd tnum"><b>{s.speed.toFixed(1)}</b> <small>m/s</small></div>
          <div class="dim tnum">{(s.speed * MS_TO_KT).toFixed(0)} kt · {msToKmh(s.speed).toFixed(0)} km/h</div>
        </div>
      </div>
      <div class="meta tnum">
        <div><span class="label">From</span>{compass(s.deg)} {s.deg.toFixed(0)}°</div>
        <div><span class="label">Beaufort</span>{bf.n} · {bf.name}</div>
      </div>
    {:else}
      <div class="dim">No wind data at this latitude</div>
    {/if}
    <div class="foot dim">{place ?? `${loc.lat.toFixed(1)}°, ${loc.lon.toFixed(1)}°`}</div>
    {#if nearest}
      <div class="foot dim tnum">Nearest storm: <b class="n">{nearest.name}</b>, {Math.round(nearest.km).toLocaleString()} km {compass(nearest.bearing)}</div>
    {/if}
  </section>
{/if}

<style>
  .card { position: absolute; top: calc(var(--gap) * 2 + 40px + env(safe-area-inset-top, 0px)); right: 56px; width: 232px; padding: 10px 14px 12px; z-index: 3; }
  .card.hidden { display: none; }
  header { display: flex; align-items: center; margin: -4px -8px 4px 0; }
  header .label { flex: 1; }
  .main { display: flex; align-items: center; gap: 12px; }
  .spd b { font-size: 28px; font-weight: 700; }
  small { color: var(--text-dim); }
  .dim { color: var(--text-dim); font-size: 12px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; font-size: 13px; }
  .meta .label { display: block; margin-bottom: 1px; }
  .foot { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
  .n { color: var(--text); font-weight: 600; }
  @media (max-width: 900px) { .card { display: none; } }
</style>
