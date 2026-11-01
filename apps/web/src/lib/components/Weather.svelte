<script lang="ts">
  /** Headless controller: keeps decoded frames in step with app state and drives playback. */
  import { untrack } from 'svelte';
  import { app } from '#lib/stores/app.svelte';
  import { PLAYBACK } from '#lib/config';
  import { weather } from '#lib/weather/runtime.svelte';
  import { meteo, meteoPinned } from '#lib/weather/meteo.svelte';

  // Reconcile whenever model / variable / level / time / layer visibility change. Reads inside show() before its
  // first await are what this effect tracks.
  $effect(() => {
    void weather.show();
  });

  // Playback: blend smoothly between frames (mix 0..1), advancing only once the next frames are decoded so a slow
  // connection never stutters. Reduced motion steps discretely.
  $effect(() => {
    if (!app.playing || !app.weatherReady) return;
    let raf = 0;
    let t0 = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const times = app.times;
      const n = times.length;
      if (n < 2) return;
      const next = (app.frameIdx + 1) % n;
      if (next !== 0 && !weather.isReady(times[next]!)) {
        void weather.ensureAt(times[next]!);
        t0 = now;
        weather.mix = 0;
        return;
      }
      const t = (now - t0) / PLAYBACK.stepMs;
      if (t >= 1) {
        // leave the mix at ~1 until the new frame commits (which resets it to 0 on an identical image): no flicker
        app.validMs = times[next]!;
        t0 = now;
      } else if (!app.reducedMotion && next !== 0 && (weather.wind?.next || weather.scalar?.next)) {
        weather.mix = t;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      weather.mix = 0;
    };
  });

  // The meteogram follows the model (and the cached frames make this instant when the other model was already visited)
  $effect(() => {
    void app.modelId;
    void app.model;
    untrack(() => {
      if (meteo.point) void meteo.run();
      if (meteoPinned.point) void meteoPinned.run();
    });
  });
</script>
