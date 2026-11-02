<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { sondes } from '#lib/sondes/state.svelte';
  import { barbPath, dryAdiabat, frameFor, project, yFrac, type Profile } from '#lib/sondes/skewt';

  const W = 300, H = 330, PAD = { l: 38, r: 44, t: 10, b: 26 };
  const sel = $derived(sondes.selected);
  const p = $derived(sondes.profile);
  const frame = $derived(p ? frameFor(W, H, Math.min(...p.p)) : frameFor(W, H, 100));

  const line = (xs: (number | null)[], ys: number[]): string => {
    let d = '';
    let pen = false;
    xs.forEach((t, i) => {
      if (t === null) { pen = false; return; }
      const q = project(frame, t, ys[i]!);
      d += `${pen ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const tempPath = $derived(p ? line(p.t, p.p) : '');
  const dewPath = $derived(p ? line(p.td, p.p) : '');

  const isobars = $derived([1000, 850, 700, 500, 400, 300, 200, 150, 100, 70, 50, 30, 20, 10, 5].filter((x) => x <= frame.pBottom && x >= frame.pTop));
  const isotherms = Array.from({ length: 18 }, (_, i) => -120 + i * 10).filter((t) => t <= 50);
  const adiabats = Array.from({ length: 14 }, (_, i) => 240 + i * 20).map((th) => {
    const pts: string[] = [];
    for (let k = 0; k <= 24; k++) {
      const pr = frame.pBottom * Math.pow(frame.pTop / frame.pBottom, k / 24);
      const q = project(frame, dryAdiabat(th, pr), pr);
      pts.push(`${k ? 'L' : 'M'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`);
    }
    return pts.join('');
  });
  const isoLine = (t: number) => {
    const a = project(frame, t, frame.pBottom), b = project(frame, t, frame.pTop);
    return `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };
  const yOf = (pr: number) => (1 - yFrac(frame, pr)) * H;

  /** wind barbs every 50 hPa below 300, then every 25, where the profile has wind */
  const barbs = $derived.by(() => {
    if (!p) return [] as { y: number; kt: number; from: number }[];
    const out: { y: number; kt: number; from: number }[] = [];
    let lastY = Infinity;
    for (let i = 0; i < p.p.length; i++) {
      const ws = p.ws[i], wd = p.wd[i];
      if (ws == null || wd == null) continue;
      const y = yOf(p.p[i]!);
      if (lastY - y < 22 && out.length) continue;
      out.push({ y, kt: ws * 1.94384, from: wd });
      lastY = y;
    }
    return out;
  });

  function freezing(pr: Profile): string | null {
    for (let i = 1; i < pr.t.length; i++) if (pr.t[i - 1]! > 0 && pr.t[i]! <= 0) return `${Math.round(pr.alt[i]!).toLocaleString('en')} m`;
    return null;
  }
  const close = () => void sondes.select(null);
</script>

{#if sel}
  <aside class="sd glass" aria-label="Radiosonde Skew-T">
    <header>
      <div class="ttl">
        <h2>Skew-T · {sel.serial}</h2>
        <div class="sub tnum">{sel.type || 'radiosonde'} · SondeHub</div>
      </div>
      <button class="btn ghost icon" onclick={close} aria-label="Close Skew-T"><Icon name="close" size={16} /></button>
    </header>

    <div class="body">
      {#if sondes.profileState === 'loading'}
        <p class="note">Loading the flight…</p>
      {:else if sondes.profileState === 'error'}
        <p class="note">{sondes.profileNote}</p>
        <button class="btn" onclick={() => sel && void sondes.select(sel)}>Try again</button>
      {:else if p}
        <svg viewBox="0 0 {W + PAD.l + PAD.r} {H + PAD.t + PAD.b}" role="img" aria-label="Skew-T log-p diagram of the balloon ascent: temperature in red, dew point in green">
          <defs><clipPath id="skclip"><rect x="0" y="0" width={W} height={H} /></clipPath></defs>
          <g transform="translate({PAD.l} {PAD.t})">
            <rect x="0" y="0" width={W} height={H} class="bg" />
            <g clip-path="url(#skclip)">
              {#each adiabats as d, i (i)}<path d={d} class="ad" />{/each}
              {#each isotherms as t (t)}<path d={isoLine(t)} class={t === 0 ? 'zero' : 'iso'} />{/each}
              {#each isobars as pr (pr)}<line x1="0" x2={W} y1={yOf(pr)} y2={yOf(pr)} class="ib" />{/each}
              <path d={dewPath} class="td" />
              <path d={tempPath} class="tt" />
            </g>
            <rect x="0" y="0" width={W} height={H} class="frm" />
            {#each isobars as pr (pr)}<text x="-5" y={yOf(pr) + 3.5} class="lab" text-anchor="end">{pr}</text>{/each}
            {#each isotherms.filter((t) => t >= -40 && t <= 40 && t % 20 === 0) as t (t)}
              <text x={project(frame, t, frame.pBottom).x} y={H + 14} class="lab" text-anchor="middle">{t}</text>
            {/each}
            <text x={W / 2} y={H + 25} class="ax" text-anchor="middle">°C at the surface, lines lean with height</text>
            <text x="-30" y="-1" class="ax">hPa</text>
            <g transform="translate({W + 22} 0)">
              {#each barbs as b, i (i)}
                <g transform="translate(0 {b.y}) rotate({b.from})"><path d={barbPath(b.kt)} class="bb" /></g>
              {/each}
            </g>
          </g>
        </svg>
        <div class="key"><i class="r"></i>temperature <i class="g"></i>dew point <i class="b"></i>wind barbs (kt)</div>
        <dl class="grid tnum">
          <div><dt>Highest point</dt><dd>{Math.round(p.maxAlt).toLocaleString('en')} <small>m</small></dd></div>
          <div><dt>Status</dt><dd class="s">{p.ascending ? 'still ascending' : 'burst, descending'}</dd></div>
          <div><dt>First reading</dt><dd class="s">{Math.round(p.p[0]!)} hPa{p.pressureEstimated ? ' (est.)' : ''} · {p.t[0]!.toFixed(1)} °C</dd></div>
          <div><dt>Freezing level</dt><dd class="s">{freezing(p) ?? 'not reached'}</dd></div>
        </dl>
        <p class="small">{p.pressureEstimated ? 'This sonde sends no pressure, so pressure is estimated from its height and temperature (about 1 % accurate). ' : ''}From the balloon's own readings, received by radio amateurs, so it starts where the balloon was first heard, not always at the ground. The descent is not drawn. Dew point is shown only where the humidity sensor is reliable. Raw sensor data, not quality-controlled.</p>
        <button class="btn" onclick={() => sel && void sondes.select(sel)}><Icon name="locate" size={14} />Refresh</button>
      {/if}
    </div>
  </aside>
{/if}

<style>
  .sd { position: absolute; top: calc(var(--gap) * 2 + 40px + env(safe-area-inset-top, 0px)); right: 56px; width: 410px; max-height: calc(100% - var(--timebar-h) - 90px - var(--gap) * 3); display: flex; flex-direction: column; z-index: 7; animation: in 0.25s ease-out; }
  @keyframes in { from { opacity: 0; transform: translateX(16px); } }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 10px 6px 16px; }
  .ttl { flex: 1; min-width: 0; }
  h2 { margin: 0; font-size: 17px; }
  .sub { color: var(--text-dim); font-size: 12px; }
  .body { padding: 0 12px 14px; overflow-y: auto; scrollbar-width: thin; }
  svg { width: 100%; height: auto; display: block; }
  .bg { fill: rgba(5, 9, 20, 0.55); }
  .frm { fill: none; stroke: rgba(180, 200, 240, 0.45); stroke-width: 1; }
  .iso { fill: none; stroke: rgba(150, 170, 210, 0.22); stroke-width: 0.8; }
  .zero { fill: none; stroke: rgba(94, 224, 255, 0.55); stroke-width: 1.1; stroke-dasharray: 4 3; }
  .ib { stroke: rgba(150, 170, 210, 0.3); stroke-width: 0.8; }
  .ad { fill: none; stroke: rgba(255, 190, 120, 0.2); stroke-width: 0.8; }
  .tt { fill: none; stroke: #ff5d5d; stroke-width: 2.2; stroke-linejoin: round; }
  .td { fill: none; stroke: #4ade80; stroke-width: 2.2; stroke-linejoin: round; }
  .bb { fill: none; stroke: #dbe8ff; stroke-width: 1.2; }
  .lab { fill: var(--text-dim, #a9b8d8); font-size: 10px; }
  .ax { fill: var(--text-faint, #7d8cab); font-size: 9.5px; }
  .key { font-size: 11.5px; color: var(--text-dim); margin: 4px 0 8px; }
  .key i { display: inline-block; width: 14px; height: 0; border-top: 2.5px solid; margin: 0 5px 3px 10px; }
  .key i:first-child { margin-left: 0; }
  .key .r { border-color: #ff5d5d; } .key .g { border-color: #4ade80; } .key .b { border-color: #dbe8ff; border-top-width: 1.5px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin: 6px 0; }
  dt { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-faint); font-weight: 600; }
  dd { margin: 1px 0 0; font-size: 18px; font-weight: 700; }
  dd.s { font-size: 13.5px; font-weight: 600; }
  dd small { font-size: 12px; font-weight: 400; color: var(--text-dim); }
  .note { color: var(--text-dim); font-size: 13px; }
  .small { font-size: 11.5px; color: var(--text-faint); margin: 8px 0; }
  @media (max-width: 900px) {
    .sd { top: auto; right: var(--gap); left: var(--gap); bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b)); width: auto; max-height: 62vh; }
  }
</style>
