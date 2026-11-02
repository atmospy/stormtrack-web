<script lang="ts">
  import Icon from './Icon.svelte';
  import Sparkline from './Sparkline.svelte';
  import BarChart from './BarChart.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { auth } from '#lib/auth/auth.svelte';
  import { toast } from '#lib/stores/toast.svelte';
  import { historyVertices } from '#lib/data/contracts';
  import { groupStorms, stormBounds } from '#lib/data/active';
  import { ensureHistory, ensureStats } from '#lib/data/boot';
  import { categoryFromLabel, categoryFromWind, compass, ktToKmh, fmtAgo } from '#lib/util/storm';
  import { history } from '#lib/history/state.svelte';
  import { seasonLabel } from '#lib/data/history';

  const sel = $derived(app.selection);
  const bundle = $derived(sel?.type === 'active' && app.active ? (groupStorms(app.active).get(sel.id) ?? null) : null);
  const hist = $derived(sel?.type === 'history' ? history.find(sel.id) : null);
  const pos = $derived(bundle?.position.properties ?? null);
  const hp = $derived(hist?.properties ?? null);
  const basin = $derived(pos?.basin ?? hp?.basin ?? 'NI');
  const stats = $derived(app.stats[basin] ?? null);
  const cat = $derived(pos ? categoryFromLabel(pos.category.label, pos.wind_kt) : hp ? categoryFromLabel(hp.category, hp.max_wind_kt) : null);
  const title = $derived(pos ? (pos.name ?? pos.id) : (hp?.name ?? hp?.id ?? ''));

  const observed = $derived(
    bundle?.track ? bundle.track.properties.times.map((t, i) => ({ t: Date.parse(t), w: bundle.track!.properties.wind_kt[i] ?? NaN })).filter((p) => Number.isFinite(p.w)) : []
  );
  const forecast = $derived.by(() => {
    const f = bundle?.forecast?.properties;
    if (!f) return [];
    const t0 = Date.parse(f.init);
    return f.taus.map((tau, i) => ({ t: t0 + tau * 3600e3, w: f.wind_kt[i] ?? NaN })).filter((p) => p.w === p.w && p.t > t0);
  });
  /** Every fix of an active storm, oldest first: observed track then forecast points. */
  const fixes = $derived.by(() => {
    if (!bundle) return [];
    const out: { t: number; w: number | null; fc: boolean; tau?: number }[] = [];
    const tr = bundle.track?.properties;
    tr?.times.forEach((t, i) => out.push({ t: Date.parse(t), w: tr.wind_kt[i] ?? null, fc: false }));
    const f = bundle.forecast?.properties;
    if (f) {
      const t0 = Date.parse(f.init);
      f.taus.forEach((tau, i) => {
        if (tau > 0 && f.wind_kt[i] !== undefined) out.push({ t: t0 + tau * 3600e3, w: f.wind_kt[i] ?? null, fc: true, tau });
      });
    }
    return out.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
  });
  /** the fix nearest the slider time is the highlighted row */
  const activeFix = $derived.by(() => {
    if (app.validMs === null || !fixes.length) return -1;
    let best = 0;
    for (let i = 1; i < fixes.length; i++) if (Math.abs(fixes[i]!.t - app.validMs) < Math.abs(fixes[best]!.t - app.validMs)) best = i;
    return best;
  });
  const fmtFix = (t: number) => new Date(t).toUTCString().slice(5, 22).replace(' GMT', '');
  function goto(t: number) {
    if (!app.scrubToMs(t)) toast.show('That time is outside the weather timeline', 'info');
  }
  const annual = $derived(stats ? stats.annual.map((a) => ({ year: a.year, value: a.storms })) : []);

  $effect(() => {
    if (!sel) return;
    if (app.statsBasins.includes(basin)) void ensureStats(basin);
    if (sel.type === 'history') void ensureHistory();
  });

  function zoom() {
    if (bundle) app.flyToBounds(stormBounds(bundle));
    else if (hist) {
      const cs = historyVertices(hist.geometry);
      const xs = cs.map((c) => c[0]!), ys = cs.map((c) => c[1]!);
      app.flyToBounds([Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1]);
    }
  }
  // fly to the storm when first opened
  let lastId = '';
  $effect(() => {
    const id = sel ? `${sel.type}:${sel.id}` : '';
    if (id && id !== lastId && (bundle || hist)) zoom();
    lastId = id;
  });

  async function follow() {
    if (!pos) return;
    const r = await auth.toggleFollow(pos.id);
    if (r.ok) return;
    if (r.reason === 'signed-out') app.authOpen = true;
    else toast.show(r.message, 'warn');
  }
  const links = $derived(
    pos
      ? [pos.agency === 'NHC' ? { t: 'NHC advisory', u: 'https://www.nhc.noaa.gov/' } : { t: 'JTWC warnings', u: 'https://www.metoc.navy.mil/jtwc/jtwc.html' }, { t: 'IBTrACS', u: 'https://www.ncei.noaa.gov/products/international-best-track-archive' }]
      : [{ t: 'IBTrACS', u: 'https://www.ncei.noaa.gov/products/international-best-track-archive' }, { t: 'IMD RSMC New Delhi', u: 'https://rsmcnewdelhi.imd.gov.in/' }]
  );
  const close = () => app.select(null);
</script>

{#if sel && (bundle || hist)}
  <aside class="sp glass" aria-label="Storm details">
    <header>
      <i class="chip" style="background:{cat?.color}; box-shadow: 0 0 14px {cat?.color}"></i>
      <div class="ttl">
        <h2>{title}</h2>
        <div class="sub tnum">{pos ? pos.id : hp?.id} · {pos ? `${pos.agency} · ${pos.basin}` : `${seasonLabel(hp!.year, hp!.basin)}${hp?.basin ? ' · ' + hp.basin : ''} · historical`}</div>
      </div>
      <button class="btn ghost icon" onclick={close} aria-label="Close storm panel"><Icon name="close" size={16} /></button>
    </header>

    <div class="body">
      <div class="badge" style="--c:{cat?.color}">{cat?.name}{#if hp?.imd_grade} <span class="imd">· IMD {hp.imd_grade}</span>{/if}</div>

      <dl class="grid tnum">
        {#if pos}
          <div><dt>Wind (1-min)</dt><dd>{pos.wind_kt ?? '–'} <small>kt</small></dd><dd class="s">{pos.wind_kt != null ? Math.round(ktToKmh(pos.wind_kt)) : '–'} km/h</dd></div>
          <div><dt>Pressure</dt><dd>{pos.pressure_hpa ?? '–'} <small>hPa</small></dd></div>
          <div><dt>Position</dt><dd class="p">{Math.abs(bundle!.position.geometry.coordinates[1]).toFixed(1)}°{bundle!.position.geometry.coordinates[1] >= 0 ? 'N' : 'S'} {Math.abs(bundle!.position.geometry.coordinates[0]).toFixed(1)}°{bundle!.position.geometry.coordinates[0] >= 0 ? 'E' : 'W'}</dd></div>
          <div><dt>Motion</dt><dd class="p">{pos.heading_deg != null ? `${compass(pos.heading_deg)} ` : ''}{pos.speed_kmh != null ? `${Math.round(pos.speed_kmh)} km/h` : '–'}</dd></div>
        {:else if hp}
          <div><dt>Peak wind</dt><dd>{hp.max_wind_kt ?? '–'} <small>kt</small></dd></div>
          <div><dt>{hp.basin && ['SI','SP','SA'].includes(hp.basin) ? 'Season' : 'Year'}</dt><dd>{seasonLabel(hp.year, hp.basin)}</dd></div>
          <div><dt>Start</dt><dd class="p">{hp.start || '–'}</dd></div>
          <div><dt>End</dt><dd class="p">{hp.end || '–'}</dd></div>
        {/if}
      </dl>
      {#if pos}<div class="upd">Fix {fmtAgo(pos.time)} · {new Date(pos.time).toUTCString().slice(5, 22)} UTC</div>{/if}

      <p class="caveat">
        {#if pos}
          Winds are <b>{pos.wind_period_min}-minute sustained</b> ({pos.agency}). IMD reports 3-minute winds, so values are not directly comparable across agencies.
        {:else}
          Peak wind as recorded by the source agency (IMD uses 3-minute averaging, NHC/JTWC 1-minute); do not compare across agencies directly.
        {/if}
      </p>

      {#if observed.length > 1}
        <div class="sec">
          <div class="label">Wind over time <span class="leg"><i class="o"></i>observed<i class="f"></i>forecast</span></div>
          <Sparkline {observed} {forecast} />
        </div>
      {/if}
      {#if fixes.length > 1}
        <div class="sec">
          <div class="label">Track fixes <span class="leg">UTC · click to jump</span></div>
          <div class="fixes tnum" role="list">
            {#each fixes as x, i (i)}
              {@const c = categoryFromWind(x.w)}
              <button class="fx" class:on={i === activeFix} class:fc={x.fc} role="listitem" onclick={() => goto(x.t)} title={x.fc ? `Forecast +${x.tau} h` : 'Observed fix'}>
                <span class="d">{fmtFix(x.t)}</span>
                <span class="k" style="background:{c.color}">{x.fc ? 'F' : 'O'}</span>
                <span class="w">{x.w ?? '–'} kt</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
      {#if bundle?.cone}<p class="small">Cone: {bundle.cone.properties.basis || 'uncertainty cone'}</p>{/if}

      <div class="sec">
        <div class="label">Climatology · {basin} storms per year</div>
        {#if annual.length}
          <BarChart data={annual} highlight={hp?.year ?? null} label="Annual storm count, {basin} basin" />
          {#if stats?.notes}<p class="small">{stats.notes}</p>{/if}
        {:else if !app.statsBasins.includes(basin)}
          <p class="small">Climatology is not yet published for the {basin} basin.</p>
        {:else}
          <p class="small">Loading…</p>
        {/if}
      </div>

      <div class="acts">
        <button class="btn" onclick={zoom}><Icon name="locate" size={14} />Zoom to</button>
        {#if pos}<button class="btn" class:primary={auth.isFollowing(pos.id)} onclick={follow}><Icon name="bell" size={14} />{auth.isFollowing(pos.id) ? 'Following' : 'Follow'}</button>{/if}
      </div>
      <div class="links">{#each links as l (l.u)}<a href={l.u} target="_blank" rel="noopener noreferrer"><Icon name="link" size={12} /> {l.t}</a>{/each}</div>
    </div>
  </aside>
{/if}

<style>
  .sp { position: absolute; top: calc(var(--gap) * 2 + 40px + env(safe-area-inset-top, 0px)); right: 56px; width: 340px; max-height: calc(100% - var(--timebar-h) - 90px - var(--gap) * 3); display: flex; flex-direction: column; z-index: 6; animation: in 0.25s ease-out; }
  @keyframes in { from { opacity: 0; transform: translateX(16px); } }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 10px 10px 16px; }
  .chip { width: 12px; height: 12px; border-radius: 50%; flex: none; }
  .ttl { flex: 1; min-width: 0; }
  h2 { margin: 0; font-size: 18px; letter-spacing: 0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { color: var(--text-dim); font-size: 12px; }
  .body { padding: 0 16px 16px; overflow-y: auto; scrollbar-width: thin; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 650; color: var(--c); border: 1px solid var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
  .imd { opacity: 0.8; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; margin: 14px 0 6px; }
  dt { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-faint); font-weight: 600; }
  dd { margin: 1px 0 0; font-size: 20px; font-weight: 700; }
  dd.p { font-size: 14px; font-weight: 600; }
  dd.s { font-size: 12px; font-weight: 400; color: var(--text-dim); margin: 0; }
  dd small { font-size: 12px; font-weight: 400; color: var(--text-dim); }
  .upd { font-size: 11.5px; color: var(--text-faint); }
  .caveat { font-size: 12px; color: var(--text-dim); background: rgba(255, 176, 59, 0.07); border: 1px solid rgba(255, 176, 59, 0.22); padding: 8px 10px; border-radius: 9px; margin: 12px 0; }
  .small { font-size: 11.5px; color: var(--text-faint); margin: 6px 0 0; }
  .sec { margin-top: 14px; }
  .sec .label { margin-bottom: 6px; }
  .leg { float: right; text-transform: none; letter-spacing: 0; font-weight: 400; }
  .leg i { display: inline-block; width: 12px; height: 0; border-top: 2px solid var(--accent); margin: 0 4px 3px 8px; }
  .leg i.f { border-top: 2px dashed #fff; }
  .fixes { max-height: 190px; overflow-y: auto; scrollbar-width: thin; border: 1px solid var(--line); border-radius: 9px; }
  .fx { display: grid; grid-template-columns: 1fr 22px 58px; gap: 8px; align-items: center; width: 100%; padding: 5px 10px; border: 0; background: none; color: var(--text-dim); font-size: 12px; text-align: left; cursor: pointer; }
  .fx:hover { background: rgba(255, 255, 255, 0.05); color: var(--text); }
  .fx.on { background: rgba(94, 224, 255, 0.16); color: var(--text); }
  .fx.fc .d { font-style: italic; }
  .fx .k { display: inline-block; text-align: center; border-radius: 4px; color: #050914; font-weight: 700; font-size: 10.5px; line-height: 16px; }
  .fx .w { text-align: right; }
  .acts { display: flex; gap: 8px; margin-top: 16px; }
  .links { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 12px; }
  @media (max-width: 900px) {
    .sp { top: auto; right: var(--gap); left: var(--gap); bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b)); width: auto; max-height: 52vh; }
  }
</style>
