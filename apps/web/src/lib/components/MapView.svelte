<script lang="ts">
  import { onMount } from 'svelte';
  import type { Map as MlMap, Marker, Popup, MapMouseEvent } from 'maplibre-gl';
  import type * as MapLibre from 'maplibre-gl';
  import { MAP, WIND_LOOK } from '#lib/config';
  import { app } from '#lib/stores/app.svelte';
  import { toast } from '#lib/stores/toast.svelte';
  import { weather } from '#lib/weather/runtime.svelte';
  import { meteo } from '#lib/weather/meteo.svelte';
  import { windMetaFor } from '#lib/data/weather';
  import { createWindLayer, WHITE_RAMP, WIND_RAMP, type WindLayerLike } from '#lib/wind/adapter';
  import { computeIsobars, createScalarLayer, rampFor, scalarMeta, type ScalarLayerLike, type IsobarResult } from '#lib/scalar/adapter';
  import { ProjectionControl } from '#lib/map/projectionControl';
  import { addIsobarLayers, setIsobars, setIsobarVisibility } from '#lib/map/isobars';
  import { addLightningLayers, setCoverage, setLightningVisibility } from '#lib/map/lightning';
  import type { LightningGLLayer } from '#lib/lightning/layer';
  import { applyHistoryFilter, decorate, setHistorySource } from '#lib/map/history';
  import { history, stormsNear } from '#lib/history/state.svelte';
  import { lightning } from '#lib/lightning/state.svelte';
  import { restored } from '#lib/state/share.svelte';
  import { groupStorms } from '#lib/data/active';
  import { darkStyle } from '#lib/map/style';
  import { ACTIVE_HIT_LAYERS, HISTORY_LAYER, addStormLayers, setActiveData, setHighlight, setStormVisibility, startPulse } from '#lib/map/storms';
  import { setSatellite } from '#lib/map/satellite';
  import { cloudTime, setClouds } from '#lib/map/clouds';
  import { NOWCAST_HIT_LAYERS, addNowcastLayers, nowcastPopup, setNowcastData, setNowcastVisibility } from '#lib/map/nowcast';
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
  let scalarLayer: ScalarLayerLike | null = $state.raw(null);
  let creatingScalar = false;
  let pin: Marker | null = null;
  let popup: Popup | null = null;
  let stopPulse: (() => void) | null = null;

  const effectiveMode = $derived(app.reducedMotion ? 'arrows' : app.windMode);
  const WIND_ID = 'wind-particles';
  const SCALAR_ID = 'scalar-field';

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
        center: restored.lat !== undefined && restored.lon !== undefined ? [restored.lon, restored.lat] : MAP.initialCenter,
        zoom: restored.zoom ?? MAP.initialZoom,
        minZoom: 0.8,
        maxPitch: 60,
        attributionControl: { compact: true },
        fadeDuration: 0,
        canvasContextAttributes: { antialias: false }
      });
      m.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'top-right');
      m.addControl(new ProjectionControl(), 'top-right');
      m.on('load', () => {
        if (disposed) return;
        addArrowLayer(m);
        addIsobarLayers(m, 'water_label');
        addNowcastLayers(m, 'st-history');
        addStormLayers(m);
        addHazardLayers(m);
        addLightningLayers(m, 'st-history');
        wire(m);
        map = m;
        const c0 = m.getCenter();
        app.center = { lon: c0.lng, lat: c0.lat };
        app.zoom = m.getZoom();
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

  const wrapLon = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;
  function readoutAt(lng: number, lat: number, pinned: boolean) {
    const lon = wrapLon(lng);
    return { lon, lat, sample: windSample(lon, lat), scalar: weather.sampleScalarAt(lon, lat), pinned };
  }

  function placePin(lng: number, lat: number) {
    pin?.remove();
    const dot = document.createElement('div');
    dot.className = 'pin';
    pin = new maplibre.Marker({ element: dot }).setLngLat([lng, lat]).addTo(map!);
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
        const interactive = [...ACTIVE_HIT_LAYERS, ...HAZARD_HIT_LAYERS, ...(app.layers.nowcast ? NOWCAST_HIT_LAYERS : []), ...(app.layers.history ? [HISTORY_LAYER] : [])];
        m.getCanvas().style.cursor = hits(m, ev, interactive, 5).length ? 'pointer' : '';
        if (app.readout?.pinned) return;
        const { lng, lat } = ev.lngLat;
        if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90) app.readout = readoutAt(lng, lat, false);
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
        // a forecast or track point also moves the time slider to that moment
        const pt = st.find((f) => f.layer.id === 'st-fc-pts' || f.layer.id === 'st-track-pts');
        if (pt && typeof pt.properties?.t === 'number') app.scrubToMs(pt.properties.t);
        const at = app.active ? groupStorms(app.active).get(sid)?.position.geometry.coordinates : undefined;
        if (at) meteo.open(at[0]!, at[1]!);
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
      if (app.layers.nowcast) {
        const nc = hits(m, e, NOWCAST_HIT_LAYERS)[0];
        if (nc) {
          popup?.remove();
          popup = new maplibre.Popup({ offset: 4, closeButton: true, maxWidth: '300px' })
            .setLngLat(e.lngLat)
            .setDOMContent(nowcastPopup(nc.properties as Record<string, unknown>))
            .addTo(m);
          gate.interact();
          return;
        }
      }
      if (app.layers.history) {
        const h = hits(m, e, [HISTORY_LAYER], 6)[0];
        const hid = h?.properties?.id as string | undefined;
        if (hid) {
          app.select({ type: 'history', id: hid });
          return;
        }
      }
      // empty map: pin a readout here, open the meteogram, remember the point for "storms near here"
      const { lng, lat } = e.lngLat;
      const lon = wrapLon(lng);
      app.readout = readoutAt(lng, lat, true);
      placePin(lng, lat);
      meteo.open(lon, lat);
      history.point = { lon, lat };
      lightning.updateCentre(lon, lat);
      gate.interact();
    });
    m.on('moveend', () => {
      const c = m.getCenter();
      app.center = { lon: c.lng, lat: c.lat };
      app.zoom = m.getZoom();
      lightning.updateCentre(wrapLon(c.lng), c.lat);
      setLightningView(m);
      if (effectiveMode === 'arrows' && app.layers.wind) refreshArrows();
    });
  }

  function setLightningView(m: MlMap) {
    const b = m.getBounds();
    const spanLon = b.getEast() - b.getWest();
    lightning.setView(spanLon >= 360 || m.getZoom() < 1.6 ? null : { west: wrapLon(b.getWest()), south: b.getSouth(), east: wrapLon(b.getEast()), north: b.getNorth() });
  }

  function windSample(lon: number, lat: number) {
    return weather.sampleWind(lon, lat);
  }

  // pinned readout cleared elsewhere (UI) -> remove marker
  $effect(() => {
    if (!app.readout?.pinned && pin) {
      pin.remove();
      pin = null;
    }
  });
  // a pin restored from a shared link
  $effect(() => {
    if (ready && map && restored.pin && !pin) {
      const { lon, lat } = restored.pin;
      app.readout = readoutAt(lon, lat, true);
      placePin(lon, lat);
      meteo.open(lon, lat);
    }
  });

  // ---------- data -> layers ----------
  $effect(() => {
    if (ready && map && app.active) setActiveData(map, app.active, app.validMs);
  });
  $effect(() => {
    if (ready && map) setStormVisibility(map, { storms: app.layers.storms, history: app.layers.history });
  });
  $effect(() => {
    if (app.layers.history && history.index) void ensureHistory();
  });
  // history: data is set only when a basin is first loaded; everything else is a cheap filter change
  $effect(() => {
    const loaded = history.loaded;
    if (!(ready && map)) return;
    setHistorySource(map, Object.entries(loaded).flatMap(([b, c]) => decorate(c, b)));
  });
  const nearIds = $derived.by(() => {
    if (!history.near || !history.point) return null;
    return stormsNear(history.visible, history.point.lon, history.point.lat, history.nearKm).map((f) => f.properties.id);
  });
  $effect(() => {
    const filter = { basins: history.enabled, years: history.yearsEffective, minCategory: history.minCategory, near: nearIds };
    void history.loaded; // re-apply after the source is replaced
    if (ready && map) applyHistoryFilter(map, filter);
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
    if (ready && map) setSatellite(map, app.layers.satellite && app.availability.satellite === 'ready', app.satellite);
  });
  $effect(() => {
    if (ready && map) setClouds(map, app.layers.clouds, cloudTime(app.validMs, Date.now()));
  });
  $effect(() => {
    if (ready && map && app.nowcast) setNowcastData(map, app.nowcast);
  });
  $effect(() => {
    if (ready && map) setNowcastVisibility(map, app.layers.nowcast && app.availability.nowcast === 'ready');
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

  // ---------- lightning ----------
  $effect(() => {
    if (!app.layers.lightning) return;
    return lightning.start();
  });
  $effect(() => {
    if (!(ready && map)) return;
    setLightningVisibility(map, app.layers.lightning && lightning.availability === 'ready');
  });
  $effect(() => {
    const b = lightning.bundle;
    if (ready && map) {
      setCoverage(map, b?.coverage ?? null);
      lightning.updateCentre(wrapLon(app.center.lon), app.center.lat);
      setLightningView(map);
    }
  });
  // the animated strike layer (WebGL, code-split): created the first time lightning is switched on
  let glLayer = $state.raw<LightningGLLayer | null>(null);
  let creatingGl = false;
  $effect(() => {
    if (!(ready && map && app.layers.lightning) || glLayer || creatingGl) return;
    creatingGl = true;
    const m = map;
    import('#lib/lightning/layer')
      .then(({ LightningGLLayer }) => {
        if (!map) return;
        const l = new LightningGLLayer({ clock: lightning.playbackMs, windowS: lightning.window * 60 });
        m.addLayer(l, m.getLayer('st-history') ? 'st-history' : undefined);
        glLayer = l;
        lightning.attachLayer(l);
      })
      .catch((e) => console.warn('lightning animation unavailable', e))
      .finally(() => (creatingGl = false));
  });
  $effect(() => {
    glLayer?.setVisible(app.layers.lightning && lightning.availability === 'ready');
  });
  $effect(() => {
    glLayer?.setWindowS(lightning.window * 60);
  });

  // ---------- weather: wind particles ----------
  const windShown = $derived(weather.wind);
  const scalarShown = $derived(weather.scalar);
  $effect(() => {
    const cur = windShown?.cur;
    if (!(ready && map && cur) || windLayer || creatingWind) return;
    creatingWind = true;
    const small = matchMedia('(max-width: 720px)').matches;
    createWindLayer({ id: WIND_ID, particleCount: small ? 12000 : 28000, colorRamp: WIND_RAMP, reducedMotion: false })
      .then((layer) => {
        const w = weather.wind;
        if (!map || !w) return;
        layer.setFrame(windMeta(w.cur), w.cur.bitmap, w.next?.bitmap ?? null, 0);
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

  // over a filled colour field the particles step back so the field can be read; contour fields keep the full look
  $effect(() => {
    const layer = windLayer;
    const v = app.variable;
    if (!layer) return;
    const overField = v === 'temperature' || v === 'precipitation';
    layer.setOptions(overField ? { ...WIND_LOOK.overField, colorRamp: WHITE_RAMP } : { ...WIND_LOOK.full, colorRamp: WIND_RAMP });
  });

  const windMetas = new WeakMap<object, ReturnType<typeof windMetaFor>>();
  function windMeta(s: NonNullable<typeof windShown>['cur']) {
    // a stable object per field keeps the layer from re-uploading identical metadata
    let m = windMetas.get(s.field);
    if (!m || m.width !== s.model.grid.width) {
      m = windMetaFor(s.model.grid, s.field as Parameters<typeof windMetaFor>[1]);
      windMetas.set(s.field, m);
    }
    return m;
  }
  $effect(() => {
    const w = windShown;
    const layer = windLayer;
    if (!(layer && w)) return;
    layer.setFrame(windMeta(w.cur), w.cur.bitmap, w.next?.bitmap ?? null, 0);
  });
  $effect(() => {
    const m = weather.mix;
    windLayer?.setMix(m);
    scalarLayer?.setMix(m);
    if (m > 0) map?.triggerRepaint();
  });

  // ---------- weather: scalar fill + isobars ----------
  $effect(() => {
    const sc = scalarShown?.cur;
    if (!(ready && map && sc) || scalarLayer || creatingScalar) return;
    creatingScalar = true;
    (async () => {
      const ramp = await rampFor(app.variable, app.level);
      if (!ramp || !map) return;
      const layer = await createScalarLayer({ id: SCALAR_ID, ramp, opacity: app.variable === 'pressure' ? 0.6 : 0.92 });
      const w = weather.scalar;
      if (!map || !w) return;
      layer.setFrame(scalarMeta(w.cur.model.grid, w.cur.field as never), w.cur.bitmap, w.next?.bitmap ?? null, 0);
      map.addLayer(layer, map.getLayer('iso-lines') ? 'iso-lines' : 'water_label');
      scalarLayer = layer;
    })()
      .catch((e) => {
        console.warn('scalar layer unavailable', e);
        toast.show('Colour layer unavailable on this device', 'warn');
      })
      .finally(() => (creatingScalar = false));
  });
  $effect(() => {
    const w = scalarShown;
    const layer = scalarLayer;
    if (!(layer && w)) return;
    layer.setFrame(scalarMeta(w.cur.model.grid, w.cur.field as never), w.cur.bitmap, w.next?.bitmap ?? null, 0);
  });
  // ramp follows the variable
  $effect(() => {
    const v = app.variable;
    const lv = app.level;
    const layer = scalarLayer;
    if (!layer || v === 'wind') return;
    void rampFor(v, lv).then((r) => r && layer.setRamp(r));
  });

  // isobars for MSLP: computed in the package's worker, cached per frame so playback never recomputes
  const isoCache = new Map<string, IsobarResult>();
  let isoToken = 0;
  $effect(() => {
    const w = scalarShown?.cur;
    const on = ready && map && app.layers.wind && app.variable === 'pressure' && w?.field.id === 'mslp';
    if (!(map && ready)) return;
    setIsobarVisibility(map, !!on);
    if (!on || !w) return;
    const key = `${w.ref.model.model}@${w.ref.model.run}/${w.ref.index}`;
    const hit = isoCache.get(key);
    if (hit) return setIsobars(map, hit);
    const my = ++isoToken;
    computeIsobars(w.bitmap, scalarMeta(w.model.grid, w.field as never))
      .then((r) => {
        isoCache.set(key, r);
        if (isoCache.size > 24) isoCache.delete(isoCache.keys().next().value as string);
        if (my === isoToken && map) setIsobars(map, r);
      })
      .catch((e) => console.warn('isobars unavailable', e));
  });

  // ---------- weather: visibility ----------
  $effect(() => {
    if (!(ready && map)) return;
    const on = app.layers.wind && app.availability.wind === 'ready';
    const windOn = on && !!windShown;
    if (map.getLayer(WIND_ID)) map.setLayoutProperty(WIND_ID, 'visibility', windOn && effectiveMode === 'particles' ? 'visible' : 'none');
    map.setLayoutProperty('wind-arrows', 'visibility', windOn && effectiveMode === 'arrows' ? 'visible' : 'none');
    scalarLayer?.setVisible(on && !!scalarShown);
  });

  function refreshArrows() {
    if (map && weather.wind) updateArrows(map, { sample: (lon, lat) => weather.sampleWind(lon, lat) });
  }
  $effect(() => {
    weather.wind; // re-run when the frame changes
    if (ready && map && app.layers.wind && effectiveMode === 'arrows') refreshArrows();
  });

  // ---------- camera ----------
  /** right edge of the left layer panel (so flights keep the target clear of it), 0 on narrow screens */
  function leftClear(): number {
    if (window.innerWidth <= 900) return 0;
    const el = document.querySelector('aside.panel');
    return el ? Math.ceil(el.getBoundingClientRect().right) + 16 : 0;
  }
  let lastFly = 0;
  $effect(() => {
    const r = app.flyRequest;
    if (!(ready && map && r) || r.n === lastFly) return;
    lastFly = r.n;
    const duration = app.reducedMotion ? 0 : 1900;
    const wide = window.innerWidth > 900;
    const left = Math.max(leftClear(), 60);
    const right = wide && app.selection ? 420 : 60;
    if (r.bounds) {
      map.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], {
        padding: { top: 90, bottom: 150, left, right },
        maxZoom: 6, duration
      });
    } else {
      map.flyTo({ center: [r.lon, r.lat], zoom: r.zoom ?? Math.max(map.getZoom(), 4), duration, essential: false, curve: 1.5, padding: { top: 0, bottom: 0, left: wide ? left - 60 : 0, right: wide && app.selection ? right - 60 : 0 } });
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
