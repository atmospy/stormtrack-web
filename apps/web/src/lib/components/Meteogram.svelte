<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import type { MeteoState } from '#lib/weather/meteo.svelte';
  import type { SeriesKey } from '#lib/weather/series';
  import { nearestIndex } from '#lib/weather/select';
  import { MS_TO_KT, compass } from '#lib/util/storm';
  import { auth } from '#lib/auth/auth.svelte';
  import { toast } from '#lib/stores/toast.svelte';

  let { store, pinned = false, onpin, onclose }: { store: MeteoState; pinned?: boolean; onpin?: () => void; onclose: () => void } = $props();

  const W = 600, L = 38, R = 8;
  const m = $derived(store.data);
  const pt = $derived(store.point);

  const times = $derived.by(() => {
    const set = new Set<number>();
    for (const s of [m?.wind, m?.mslp, m?.t2m, m?.precip]) for (const p of s ?? []) if (p) set.add(p.t);
    // also frames not decoded yet: take the primary timeline so the axis does not jump while loading
    for (const t of app.times) set.add(t);
    return [...set].sort((a, b) => a - b);
  });
  const t0 = $derived(times[0] ?? 0);
  const t1 = $derived(times[times.length - 1] ?? 1);
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);

  type Row = { key: SeriesKey; label: string; unit: string; h: number; color: string };
  const ROWS: Row[] = [
    { key: 'wind', label: 'Wind 10 m', unit: 'm/s', h: 62, color: '#36d9ff' },
    { key: 'mslp', label: 'Pressure', unit: 'hPa', h: 50, color: '#b8c4e8' },
    { key: 't2m', label: '2 m temp', unit: '°C', h: 50, color: '#ffb03b' },
    { key: 'precip', label: 'Precip', unit: 'mm', h: 50, color: '#4ea2f0' }
  ];
  const GAP = 14;
  const rows = $derived(
    ROWS.filter((r) => store.include.includes(r.key) && (m?.[r.key].length ?? 0) > 0).map((r, i, a) => ({ ...r, y: 6 + a.slice(0, i).reduce((s, q) => s + q.h + GAP, 0) }))
  );
  const H = $derived(rows.length ? rows[rows.length - 1]!.y + rows[rows.length - 1]!.h + 22 : 40);

  function extent(vals: number[], pad: number, floor?: number): [number, number] {
    if (!vals.length) return [0, 1];
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
    const p = (hi - lo) * pad;
    return [floor !== undefined ? Math.min(floor, lo) : lo - p, hi + p];
  }
  const valuesOf = (k: SeriesKey): { t: number; v: number }[] => {
    if (!m) return [];
    if (k === 'wind') return m.wind.flatMap((p) => (p ? [{ t: p.t, v: p.speed }] : []));
    return (m[k] as ({ t: number; value: number } | null)[]).flatMap((p) => (p ? [{ t: p.t, v: p.value }] : []));
  };
  const geo = $derived(
    rows.map((r) => {
      const vs = valuesOf(r.key);
      const [lo, hi] = r.key === 'wind' ? extent(vs.map((p) => p.v), 0.15, 0) : r.key === 'precip' ? [0, Math.max(2, ...vs.map((p) => p.v)) * 1.1] as [number, number] : extent(vs.map((p) => p.v), 0.12);
      const top = r.key === 'wind' ? 16 : 12; // headroom for the arrow strip / row label
      const y = (v: number) => r.y + r.h - ((v - lo) / (hi - lo)) * (r.h - top);
      const d = vs.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
      const area = vs.length ? `${d}L${x(vs[vs.length - 1]!.t).toFixed(1)},${y(lo)}L${x(vs[0]!.t).toFixed(1)},${y(lo)}Z` : '';
      return { ...r, lo, hi, y, d, area, n: vs.length };
    })
  );

  // direction arrows along the wind row: every ~34 px
  const arrows = $derived.by(() => {
    const w = (m?.wind ?? []).filter((p): p is NonNullable<typeof p> => !!p);
    const out: { x: number; deg: number }[] = [];
    let last = -99;
    for (const p of w) {
      const px = x(p.t);
      if (px - last >= 34) { out.push({ x: px, deg: (p.deg + 180) % 360 }); last = px; }
    }
    return out;
  });

  // x axis: 00 UTC day ticks
  const ticks = $derived.by(() => {
    const out: { x: number; label: string; major: boolean }[] = [];
    if (!times.length) return out;
    const d = new Date(t0);
    d.setUTCHours(0, 0, 0, 0);
    for (let t = d.getTime(); t <= t1; t += 86400e3) {
      if (t < t0) continue;
      out.push({ x: x(t), label: new Date(t).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric' }), major: true });
    }
    return out;
  });

  let hover = $state<number | null>(null);
  const focusT = $derived(hover ?? app.validMs ?? t0);
  const at = <T extends { t: number } | null>(arr: T[] | undefined): T | null => {
    const v = (arr ?? []).filter((p): p is NonNullable<T> => !!p);
    if (!v.length) return null;
    let best = v[0]!;
    for (const p of v) if (Math.abs(p.t - focusT) < Math.abs(best.t - focusT)) best = p;
    return best;
  };
  const cw = $derived(at(m?.wind)), cp = $derived(at(m?.mslp)), ct = $derived(at(m?.t2m)), cr = $derived(at(m?.precip));
  const tLabel = $derived(new Date(focusT).toLocaleString('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC');

  let svg: SVGSVGElement | undefined = $state();
  function tAt(ev: PointerEvent): number | null {
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    if (px < L || px > W - R) return null;
    return t0 + ((px - L) / (W - L - R)) * (t1 - t0);
  }
  const coord = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;
  const nowX = $derived(app.validMs !== null && app.validMs >= t0 && app.validMs <= t1 ? x(app.validMs) : null);
  async function savePlace() {
    if (!pt) return;
    const res = await auth.savePlace(`${pt.lat.toFixed(2)}, ${pt.lon.toFixed(2)}`, pt.lat, pt.lon);
    if (res.ok) toast.show('Place saved');
    else if (res.reason === 'signed-out') app.authOpen = true;
    else toast.show(res.message, 'warn');
  }
  const fmt = (v: number, d = 0) => v.toFixed(d);
</script>

{#if pt}
  <section class="mg glass" class:pinned aria-label="Meteogram">
    <header>
      <div class="ttl">
        <b class="tnum">{coord(pt.lat, 'N', 'S')} {coord(pt.lon, 'E', 'W')}</b>
        <span class="sub">{app.model?.name ?? ''} · from model frames, no API calls</span>
      </div>
      <button class="btn ghost" onclick={savePlace} aria-label="Save this place">Save place</button>
      {#if onpin && !pinned}<button class="btn ghost icon" onclick={onpin} aria-label="Pin this meteogram" title="Pin: keep this card while exploring elsewhere"><Icon name="pin" size={15} /></button>{/if}
      <button class="btn ghost icon" onclick={onclose} aria-label="Close meteogram"><Icon name="close" size={15} /></button>
    </header>

    <div class="chips" role="group" aria-label="Series (only the ticked ones are downloaded)">
      {#each ROWS as r (r.key)}
        <button class:on={store.include.includes(r.key)} aria-pressed={store.include.includes(r.key)} style="--c:{r.color}" onclick={() => store.toggleSeries(r.key)}><i></i>{r.label}</button>
      {/each}
      {#if store.busy}<span class="prog tnum" role="status">loading {store.loaded}/{store.total}<span class="bar"><span style="width:{(store.loaded / Math.max(1, store.total)) * 100}%"></span></span></span>{/if}
    </div>

    <div class="now tnum" aria-live="off">
      <span class="t">{tLabel}</span>
      {#if cw}<span><i style="background:#36d9ff"></i>{fmt(cw.speed, 1)} m/s <small>{fmt(cw.speed * MS_TO_KT)} kt · from {compass(cw.deg)}</small></span>{/if}
      {#if cp}<span><i style="background:#b8c4e8"></i>{fmt(cp.value)} hPa</span>{/if}
      {#if ct}<span><i style="background:#ffb03b"></i>{fmt(ct.value, 1)} °C</span>{/if}
      {#if cr}<span><i style="background:#4ea2f0"></i>{fmt(cr.value, 1)} mm{#if cr.hours}<small>/{cr.hours} h</small>{/if}</span>{/if}
    </div>

    {#if store.error}<p class="err">{store.error}</p>{/if}
    {#if rows.length}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
      <svg bind:this={svg} viewBox="0 0 {W} {H}" role="img" aria-label="Forecast time series at this point" onpointermove={(e) => (hover = tAt(e))} onpointerleave={() => (hover = null)}
        onclick={(e) => { const t = tAt(e as unknown as PointerEvent); if (t !== null && app.times.length) app.scrubTo(nearestIndex(app.times, t)); }}>
        {#each ticks as tk (tk.x)}<line x1={tk.x} x2={tk.x} y1="2" y2={H - 20} class="grid" /><text x={tk.x + 3} y={H - 6} class="ax">{tk.label}</text>{/each}
        {#each geo as g (g.key)}
          <text x={L - 5} y={g.y(g.hi) + 3} class="ax" text-anchor="end">{fmt(g.hi, 0)}</text>
          <text x={L - 5} y={g.y(g.lo)} class="ax" text-anchor="end">{fmt(g.lo, 0)}</text>
          <text x={L + 3} y={g.y(g.lo) - (g.h ?? 50) + 9} class="lab">{g.label} ({g.unit})</text>
          <line x1={L} x2={W - R} y1={g.y(g.lo)} y2={g.y(g.lo)} class="grid" />
          {#if g.key === 'precip'}
            {#each (m?.precip ?? []) as p, i (i)}
              {#if p && p.value > 0.05}
                {@const bw = Math.max(2, ((p.hours || 3) * 3600e3 / Math.max(1, t1 - t0)) * (W - L - R) - 2)}
                <rect x={x(p.t) - bw} width={bw} y={g.y(p.value)} height={Math.max(1, g.y(g.lo) - g.y(p.value))} rx="2" fill={g.color} opacity="0.9" />
              {/if}
            {/each}
          {:else}
            {#if g.key === 'wind'}<path d={g.area} fill={g.color} opacity="0.16" />{/if}
            <path d={g.d} fill="none" stroke={g.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          {/if}
        {/each}
        {#if rows[0]?.key === 'wind'}
          {#each arrows as a (a.x)}<g transform="translate({a.x},{rows[0].y + 4}) rotate({a.deg})"><path d="M0,-5 L3.5,4 L0,2 L-3.5,4Z" fill="#e6eefc" opacity="0.85" /></g>{/each}
        {/if}
        {#if nowX !== null}<line x1={nowX} x2={nowX} y1="2" y2={H - 20} class="now-l" />{/if}
        {#if hover !== null}<line x1={x(hover)} x2={x(hover)} y1="2" y2={H - 20} class="cross" />{/if}
      </svg>
    {:else if store.busy}
      <p class="empty">Reading the forecast frames for this point…</p>
    {:else}
      <p class="empty">This model has no time series for the chosen variables.</p>
    {/if}

    <table class="sr">
      <caption>Forecast at this point</caption>
      <thead><tr><th>Time (UTC)</th><th>Wind m/s</th><th>Wind from</th><th>MSLP hPa</th><th>2 m temp °C</th></tr></thead>
      <tbody>
        {#each m?.wind ?? m?.mslp ?? [] as p, i (i)}
          {#if p}<tr><td>{new Date(p.t).toISOString().slice(0, 16)}</td><td>{m?.wind[i] ? m.wind[i]!.speed.toFixed(1) : ''}</td><td>{m?.wind[i] ? compass(m.wind[i]!.deg) : ''}</td><td>{m?.mslp[i]?.value.toFixed(0) ?? ''}</td><td>{m?.t2m[i]?.value.toFixed(1) ?? ''}</td></tr>{/if}
        {/each}
      </tbody>
    </table>
  </section>
{/if}

<style>
  .mg { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b)); width: min(660px, calc(100vw - 2 * var(--gap))); padding: 8px 14px 10px; z-index: 5; background: var(--glass-strong); animation: in 0.2s ease-out; }
  .mg.pinned { border-color: var(--line-strong); left: auto; transform: none; right: 56px; width: min(520px, calc(100vw - 2 * var(--gap))); bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b) + 330px); }
  @keyframes in { from { opacity: 0; transform: translate(-50%, 8px); } }
  .mg.pinned { animation: none; }
  header { display: flex; align-items: center; gap: 6px; }
  .ttl { flex: 1; min-width: 0; display: grid; }
  .ttl b { font-size: 14px; }
  .sub { font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 4px 0; }
  .chips button { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; font-size: 11.5px; border-radius: 12px; border: 1px solid var(--line); background: none; color: var(--text-faint); }
  .chips button.on { color: var(--text); border-color: var(--line-strong); }
  .chips i { width: 8px; height: 8px; border-radius: 50%; background: var(--c); opacity: 0.35; }
  .chips button.on i { opacity: 1; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .prog { margin-left: auto; font-size: 11px; color: var(--text-dim); display: inline-flex; align-items: center; gap: 6px; }
  .bar { display: inline-block; width: 70px; height: 4px; border-radius: 2px; background: rgba(255, 255, 255, 0.12); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--accent); }
  .now { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--text); margin: 4px 0 2px; }
  .now .t { color: var(--text-dim); }
  .now i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
  .now small { color: var(--text-faint); margin-left: 4px; }
  svg { width: 100%; height: auto; display: block; touch-action: pan-y; cursor: crosshair; }
  .grid { stroke: rgba(140, 170, 230, 0.14); stroke-width: 1; }
  .ax { fill: var(--text-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
  .lab { fill: var(--text-dim); font-size: 10.5px; }
  .now-l { stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 3 3; }
  .cross { stroke: rgba(255, 255, 255, 0.55); stroke-width: 1; }
  .empty, .err { font-size: 12px; color: var(--text-dim); margin: 10px 0; }
  .err { color: var(--danger); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 720px) { .mg, .mg.pinned { left: var(--gap); right: var(--gap); transform: none; width: auto; bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b)); max-height: 60vh; overflow-y: auto; } .mg.pinned { display: none; } }
</style>
