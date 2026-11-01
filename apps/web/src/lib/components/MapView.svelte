<script lang="ts">
  import { onMount } from 'svelte';
  import type { Map as MlMap, Marker, Popup, MapMouseEvent } from 'maplibre-gl';
  import type * as MapLibre from 'maplibre-gl';
  import { MAP } from '#lib/config';
  import { app } from '#lib/stores/app.svelte';
  import { toast } from '#lib/stores/toast.svelte';
  import { windRuntime } from '#lib/wind/runtime.svelte';
  import { createWindLayer, WIND_RAMP, type WindLayerLike } from '#lib/wind/adapter';
  import { darkStyle } from '#lib/map/style';
  import { ACTIVE_HIT_LAYERS, HISTORY_LAYER, addStormLayers, setActiveData, setHighlight, setHistoryData, setStormVisibility, startPulse } from '#lib/map/storms';
  import { HAZARD_HIT_LAYERS, addHazardLayers, popupContent, setHazardData, setHazardVisibility } from '#lib/map/hazards';
  import { addArrowLayer, updateArrows } from '#lib/map/arrows';
  import { ensureHistory } from '#lib/data/boot';
  import { gate } from '#lib/stores/gate.svelte';

  let el: HTMLDivElement;
  let map: MlMap | undefined = $state.raw();
  let ready = $state(false);
  let maplibre: typeof MapLibre;
  let windLayer: WindLayerLike | null = $state.raw(null);
  let creatingWind = false;
  let pin: Marker | null = null;
  let popup: Popup | null = null;
  let stopPulse: (() => void) | null = null;

  const effectiveMode = $derived(app.reducedMotion ? 'arrows' : app.windMode);
  const WIND_ID = 'wind-particles';

  onMount(() => {
    let disposed = false;
    (async () => {
      const [mod, workerAsset] = await Promise.all([
        import('maplibre-gl'),
        // MapLibre 6 loads its worker as a sibling file of the main script; once Vite bundles the
        // main script into a hashed chunk that path 404s in production (blank map). Emit the worker
        // as its own asset and point MapLibre at it explicitly.
        import('maplibre-gl/dist/maplibre-gl-worker.mjs?url'),
        import('maplibre-gl/dist/maplibre-gl.css')
      ]);
      if (disposed) return;
      mod.setWorkerUrl(new URL(workerAsset.default, window.location.href).href);
      maplibre = mod;
      const m = new maplibre.Map({
        container: el,
        style: darkStyle(),
        center: MAP.initialCenter,
        zoom: MAP.initialZoom,
        minZoom: 0.8,
        maxPitch: 60,
        attributionControl: { compact: true },
        fadeDuration: 0,
        canvasContextAttributes: { antialias: false }
      });
      m.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'top-right');
      m.on('load', () => {
        if (disposed) return;
        addArrowLayer(m);
        addStormLayers(m);
        addHazardLayers(m);
        wire(m);
        map = m;
        ready = true;
        (window as unknown as { __map?: MlMap }).__map = m;
      });
      m.on('error', (e) => {
        const status = (e as unknown as { error?: { status?: number } }).error?.status;
        if (status && status >= 400) return; // tile/glyph 404s are not actionable
        console.warn('map error', e.error?.message ?? e);
      });
    })().catch((e) => {
      console.error(e);
      toast.show('Could not load the map library', 'warn', 8000);
    });
    return () => {
      disposed = true;
      stopPulse?.();
      map?.remove();
      map = undefined;
    };
  });

  // ---------- interaction ----------
  function hits(m: MlMap, e: MapMouseEvent, layers: string[], pad = 7) {
    const present = layers.filter((l) => m.getLayer(l));
    if (!present.length) return [];
    const { x, y } = e.point;
    return m.queryRenderedFeatures([[x - pad, y - pad], [x + pad, y + pad]], { layers: present });
  }

  function wire(m: MlMap) {
    let raf = 0;
    let lastEv: MapMouseEvent | null = null;
    m.on('mousemove', (e) => {
      lastEv = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!lastEv) return;
        const ev = lastEv;
        const interactive = [...ACTIVE_HIT_LAYERS, ...HAZARD_HIT_LAYERS, ...(app.layers.history ? [HISTORY_LAYER] : [])];
        m.getCanvas().style.cursor = hits(m, ev, interactive, 5).length ? 'pointer' : '';
        if (app.readout?.pinned) return;
        const { lng, lat } = ev.lngLat;
        if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90) {
          app.readout = { lon: ((((lng + 180) % 360) + 360) % 360) - 180, lat, sample: windSample(lng, lat), pinned: false };
        }
      });
    });
    m.on('mouseout', () => {
      if (!app.readout?.pinned) app.readout = null;
    });
    m.on('click', (e) => {
      const st = hits(m, e, ACTIVE_HIT_LAYERS);
      const sid = st[0]?.properties?.id as string | undefined;
      if (sid) {
        popup?.remove();
        app.select({ type: 'active', id: sid });
        return;
      }
      const hz = hits(m, e, HAZARD_HIT_LAYERS)[0];
      if (hz) {
        if (hz.layer.id === 'hz-ev-cluster') {
          const src = m.getSource('hz-events') as unknown as { getClusterExpansionZoom(id: number): Promise<number> };
          src.getClusterExpansionZoom(hz.properties.cluster_id as number).then((z) => {
            m.easeTo({ center: (hz.geometry as GeoJSON.Point).coordinates as [number, number], zoom: z + 0.5, duration: app.reducedMotion ? 0 : 600 });
          });
          return;
        }
        popup?.remove();
        popup = new maplibre.Popup({ offset: 14, closeButton: true, maxWidth: '260px' })
          .setLngLat((hz.geometry as GeoJSON.Point).coordinates as [number, number])
          .setDOMContent(popupContent(hz.properties as Record<string, unknown>, hz.layer.id))
          .addTo(m);
        gate.interact();
        return;
      }
      if (app.layers.history) {
        const h = hits(m, e, [HISTORY_LAYER], 6)[0];
        const hid = h?.properties?.id as string | undefined;
        if (hid) {
          app.select({ type: 'history', id: hid });
          return;
        }
      }
      // empty map: pin a wind readout here
      const { lng, lat } = e.lngLat;
      app.readout = { lon: lng, lat, sample: windSample(lng, lat), pinned: true };
      pin?.remove();
      const dot = document.createElement('div');
      dot.className = 'pin';
      pin = new maplibre.Marker({ element: dot }).setLngLat([lng, lat]).addTo(m);
    });
    m.on('moveend', () => {
      const c = m.getCenter();
      app.center = { lon: c.lng, lat: c.lat };
      if (effectiveMode === 'arrows' && app.layers.wind) refreshArrows();
    });
  }

  function windSample(lon: number, lat: number) {
    return windLayer?.sample?.(lon, lat) ?? windRuntime.sample(lon, lat);
  }

  // pinned readout cleared elsewhere (UI) -> remove marker
  $effect(() => {
    if (!app.readout?.pinned && pin) {
      pin.remove();
      pin = null;
    }
  });

  // ---------- data -> layers ----------
  $effect(() => {
    if (ready && map && app.active) setActiveData(map, app.active);
  });
  $effect(() => {
    if (ready && map && app.history) setHistoryData(map, app.history);
  });
  $effect(() => {
    if (ready && map) setStormVisibility(map, { storms: app.layers.storms, history: app.layers.history });
  });
  $effect(() => {
    if (app.layers.history) void ensureHistory();
  });
  $effect(() => {
    if (ready && map) setHighlight(map, app.selection);
  });
  $effect(() => {
    if (!(ready && map)) return;
    for (const k of ['events', 'quakes', 'fires'] as const) {
      const d = app.hazards[k];
      if (d) setHazardData(map, k, d);
    }
  });
  $effect(() => {
    if (!(ready && map)) return;
    for (const k of ['events', 'quakes', 'fires'] as const) setHazardVisibility(map, k, app.layers[k] && app.availability[k] === 'ready');
  });
  $effect(() => {
    if (!(ready && map)) return;
    const on = app.layers.storms && !app.reducedMotion;
    if (on && !stopPulse) stopPulse = startPulse(map);
    else if (!on && stopPulse) {
      stopPulse();
      stopPulse = null;
    }
  });

  // ---------- wind ----------
  $effect(() => {
    const cur = windRuntime.current;
    if (!(ready && map && app.wind && cur) || windLayer || creatingWind) return;
    creatingWind = true;
    const small = matchMedia('(max-width: 720px)').matches;
    createWindLayer({ id: WIND_ID, particleCount: small ? 12000 : 28000, colorRamp: WIND_RAMP, reducedMotion: false })
      .then((layer) => {
        if (!map || !app.wind) return;
        layer.setFrame(app.wind.image, cur.image, windRuntime.next?.image ?? null, windRuntime.mix);
        map.addLayer(layer, 'water_label');
        windLayer = layer;
      })
      .catch((e) => {
        console.warn('wind layer unavailable, using arrow field', e);
        app.windMode = 'arrows';
        app.notes.wind = 'Particle layer failed to load; showing the arrow field.';
        toast.show('Wind particles unavailable, showing arrow field', 'warn');
      })
      .finally(() => (creatingWind = false));
  });

  $effect(() => {
    const cur = windRuntime.current;
    const nxt = windRuntime.next;
    const layer = windLayer;
    if (!(layer && cur && app.wind)) return;
    layer.setFrame(app.wind.image, cur.image, nxt?.index === cur.index + 1 ? nxt.image : null, 0);
  });
  $effect(() => {
    const m = windRuntime.mix;
    windLayer?.setMix(m);
    if (m > 0) map?.triggerRepaint();
  });

  $effect(() => {
    if (!(ready && map)) return;
    const on = app.layers.wind && app.availability.wind === 'ready';
    if (map.getLayer(WIND_ID)) map.setLayoutProperty(WIND_ID, 'visibility', on && effectiveMode === 'particles' ? 'visible' : 'none');
    map.setLayoutProperty('wind-arrows', 'visibility', on && effectiveMode === 'arrows' ? 'visible' : 'none');
  });

  function refreshArrows() {
    const f = windRuntime.current?.field;
    if (map && f) updateArrows(map, f);
  }
  $effect(() => {
    windRuntime.current; // re-run when the frame changes
    if (ready && map && app.layers.wind && effectiveMode === 'arrows') refreshArrows();
  });

  // ---------- camera ----------
  let lastFly = 0;
  $effect(() => {
    const r = app.flyRequest;
    if (!(ready && map && r) || r.n === lastFly) return;
    lastFly = r.n;
    const duration = app.reducedMotion ? 0 : 1900;
    if (r.bounds) {
      const wide = window.innerWidth > 900;
      map.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], {
        padding: { top: 90, bottom: 150, left: 60, right: wide && app.selection ? 420 : 60 },
        maxZoom: 6, duration
      });
    } else {
      map.flyTo({ center: [r.lon, r.lat], zoom: r.zoom ?? Math.max(map.getZoom(), 4), duration, essential: false, curve: 1.5 });
    }
  });
</script>

<div bind:this={el} class="map" aria-label="Interactive globe map" role="application"></div>
{#if !ready}
  <div class="boot" aria-hidden="true"><div class="orb"></div></div>
{/if}

<style>
  .map { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 40%, #0b1730 0%, #050914 70%); }
  .boot { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
  .orb { width: 38vmin; height: 38vmin; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #16294d, #070d1c 70%); box-shadow: 0 0 60px rgba(60, 130, 255, 0.25), inset 0 0 40px rgba(94, 224, 255, 0.08); animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: scale(1.03); box-shadow: 0 0 80px rgba(60, 130, 255, 0.4), inset 0 0 40px rgba(94, 224, 255, 0.12); } }
  :global(.pin) { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #fff; background: rgba(94, 224, 255, 0.35); box-shadow: 0 0 0 4px rgba(94, 224, 255, 0.2), 0 0 16px rgba(94, 224, 255, 0.8); }
</style>
