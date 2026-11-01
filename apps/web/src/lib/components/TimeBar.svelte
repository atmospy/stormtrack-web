<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { weather } from '#lib/weather/runtime.svelte';
  import { gate } from '#lib/stores/gate.svelte';

  const frames = $derived(app.primary?.frames ?? []);
  const frame = $derived(app.frame);
  const utc = $derived(frame ? new Date(frame.valid).toLocaleString('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC' : '');
  const local = $derived(frame ? new Date(frame.valid).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  function step(d: number) {
    app.playing = false;
    app.scrubTo(app.frameIdx + d);
    gate.interact();
  }
</script>

{#if app.weatherReady && frame}
  <section class="bar glass" aria-label="Forecast time">
    <div class="ctrl">
      <button class="btn icon ghost" onclick={() => step(-1)} aria-label="Previous frame" disabled={app.frameIdx === 0}><Icon name="step-back" size={16} /></button>
      <button class="btn icon play" onclick={() => (app.playing = !app.playing)} aria-label={app.playing ? 'Pause' : 'Play'}><Icon name={app.playing ? 'pause' : 'play'} size={16} /></button>
      <button class="btn icon ghost" onclick={() => step(1)} aria-label="Next frame" disabled={app.frameIdx >= frames.length - 1}><Icon name="step-fwd" size={16} /></button>
    </div>
    <div class="mid">
      <div class="row">
        <span class="fh tnum">{frame.fhr === 0 ? 'Analysis' : `+${frame.fhr} h`}</span>
        <span class="valid tnum">{utc}<span class="loc"> · local {local}</span></span>
        {#if weather.error}<span class="err" title={weather.error}>frame failed to load</span>{:else if weather.loading}<span class="ld" role="status">loading…</span>{/if}
      </div>
      <input type="range" min="0" max={frames.length - 1} step="1" value={app.frameIdx} oninput={(e) => { app.playing = false; app.scrubTo(+e.currentTarget.value); gate.interact(); }} aria-label="Forecast hour" aria-valuetext={frame.fhr === 0 ? 'Analysis' : `plus ${frame.fhr} hours, ${utc}`} style="--p: {frames.length > 1 ? (app.frameIdx / (frames.length - 1)) * 100 : 0}%" />
      <div class="ticks tnum" aria-hidden="true">
        <span>{frames[0]?.fhr === 0 ? 'now' : `+${frames[0]?.fhr}h`}</span><span>+{frames[Math.floor((frames.length - 1) / 2)]?.fhr}h</span><span>+{frames[frames.length - 1]?.fhr}h</span>
      </div>
    </div>
  </section>
{/if}

<style>
  .bar { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(var(--gap) + var(--safe-b)); width: min(640px, calc(100vw - 2 * var(--gap))); display: flex; align-items: center; gap: 14px; padding: 10px 16px 8px 10px; z-index: 4; }
  .ctrl { display: flex; gap: 2px; align-items: center; }
  .play { background: linear-gradient(135deg, #1ec8f0, #6b6bff); border-color: transparent; color: #04101c; width: 40px; height: 40px; border-radius: 50%; }
  .play:hover { filter: brightness(1.12); box-shadow: var(--glow); }
  .mid { flex: 1; min-width: 0; }
  .row { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
  .fh { font-size: 16px; font-weight: 700; }
  .valid { color: var(--text-dim); font-size: 12.5px; }
  .loc { color: var(--text-faint); }
  .err { color: var(--danger); font-size: 12px; margin-left: auto; }
  .ld { color: var(--text-faint); font-size: 12px; margin-left: auto; }
  input[type='range'] { -webkit-appearance: none; appearance: none; width: 100%; height: 22px; background: none; margin: 0; cursor: pointer; }
  input[type='range']::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(90deg, #36d9ff var(--p), rgba(255, 255, 255, 0.14) var(--p)); }
  input[type='range']::-moz-range-track { height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.14); }
  input[type='range']::-moz-range-progress { height: 4px; border-radius: 2px; background: #36d9ff; }
  input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #fff; margin-top: -6px; box-shadow: 0 0 0 4px rgba(94, 224, 255, 0.25), 0 0 14px rgba(94, 224, 255, 0.8); }
  input[type='range']::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 0 0 4px rgba(94, 224, 255, 0.25); }
  .ticks { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--text-faint); margin-top: -2px; }
  @media (max-width: 720px) { .bar { gap: 8px; padding: 8px 12px 6px 6px; } .loc { display: none; } }
</style>
