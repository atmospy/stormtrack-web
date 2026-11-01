<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { app, type LayerKey } from '#lib/stores/app.svelte';
  import { gate } from '#lib/stores/gate.svelte';
  import { CITIES } from '#lib/data/cities';
  import { groupStorms } from '#lib/data/active';
  import { ensureHistory } from '#lib/data/boot';
  import { categoryFromLabel } from '#lib/util/storm';
  import { toast } from '#lib/stores/toast.svelte';

  interface Item { id: string; group: string; label: string; hint?: string; color?: string; run: () => void }

  let q = $state('');
  let idx = $state(0);
  let input: HTMLInputElement | undefined = $state();
  let remote = $state<Item[]>([]);
  let searching = $state(false);

  $effect(() => {
    void ensureHistory();
    tick().then(() => input?.focus());
  });

  const close = () => (app.paletteOpen = false);
  const layerNames: [LayerKey, string][] = [['wind', 'wind'], ['storms', 'active cyclones'], ['history', 'historical tracks'], ['events', 'natural events'], ['quakes', 'earthquakes'], ['fires', 'fire hotspots']];

  const base = $derived.by<Item[]>(() => {
    const items: Item[] = [];
    if (app.active) {
      for (const b of groupStorms(app.active).values()) {
        const p = b.position.properties;
        items.push({ id: `a:${p.id}`, group: 'Active storms', label: p.name ?? p.id, hint: `${p.id} · ${p.wind_kt ?? '?'} kt`, color: categoryFromLabel(p.category.label, p.wind_kt).color, run: () => { app.select({ type: 'active', id: p.id }); gate.interact(); } });
      }
    }
    for (const [key, name] of layerNames) {
      if (app.availability[key] === 'missing' || app.availability[key] === 'error') continue;
      items.push({ id: `l:${key}`, group: 'Layers', label: `${app.layers[key] ? 'Hide' : 'Show'} ${name}`, run: () => app.toggle(key) });
    }
    items.push({ id: 'x:play', group: 'Actions', label: app.playing ? 'Pause animation' : 'Play forecast animation', hint: 'Space', run: () => (app.playing = !app.playing) });
    items.push({ id: 'x:help', group: 'Actions', label: 'Keyboard shortcuts', hint: '?', run: () => (app.helpOpen = true) });
    items.push({ id: 'x:signin', group: 'Actions', label: 'Sign in / create account', run: () => (app.authOpen = true) });
    for (const c of CITIES) items.push({ id: `c:${c.name}`, group: 'Places', label: c.name, hint: c.country, run: () => { app.flyTo(c.lon, c.lat, 6); gate.interact(); } });
    return items;
  });

  const results = $derived.by<Item[]>(() => {
    const s = q.trim().toLowerCase();
    let out: Item[];
    if (!s) {
      out = base.filter((i) => i.group !== 'Places').slice(0, 12);
    } else {
      const rank = (i: Item) => {
        const l = i.label.toLowerCase();
        return l.startsWith(s) ? 0 : l.split(/[\s,-]+/).some((w) => w.startsWith(s)) ? 1 : 2;
      };
      out = base.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(s)).sort((a, b) => rank(a) - rank(b));
      // historical storms by name or id
      if (app.history && s.length >= 2) {
        for (const f of app.history.features) {
          const p = f.properties;
          if (`${p.name ?? ''} ${p.id} ${p.year}`.toLowerCase().includes(s)) {
            out.push({ id: `h:${p.id}`, group: 'Historical storms', label: p.name ?? p.id, hint: `${p.year} · ${p.max_wind_kt ?? '?'} kt`, color: categoryFromLabel(p.category, p.max_wind_kt).color, run: () => { app.layers.history = true; app.select({ type: 'history', id: p.id }); } });
            if (out.length > 40) break;
          }
        }
      }
      out = out.slice(0, 14);
      out.push(...remote);
      out.push({ id: 'n:search', group: 'Search the map', label: `Search OpenStreetMap for "${q.trim()}"`, hint: 'Enter · Nominatim', run: () => void geocode(q.trim()) });
    }
    return out;
  });

  async function geocode(text: string) {
    searching = true;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(text)}`, { headers: { Accept: 'application/json' } });
      const j = (await r.json()) as { display_name: string; lat: string; lon: string }[];
      if (!j.length) {
        toast.show(`No places found for "${text}"`, 'warn');
        return;
      }
      remote = j.map((p, n) => ({ id: `r:${n}`, group: 'OpenStreetMap results', label: p.display_name.split(',').slice(0, 2).join(','), hint: p.display_name.split(',').slice(-1)[0]?.trim(), run: () => app.flyTo(+p.lon, +p.lat, 8) }));
      idx = base.length ? results.length : 0;
      gate.interact();
    } catch {
      toast.show('Place search is unavailable right now', 'warn');
    } finally {
      searching = false;
    }
  }
  $effect(() => {
    q;
    remote = [];
    idx = 0;
  });

  function choose(it: Item | undefined) {
    if (!it) return;
    if (it.id === 'n:search') return it.run();
    close();
    it.run();
    if (it.group === 'Places' || it.group === 'Active storms') gate.interact();
  }
  function onkey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(results.length - 1, idx + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(results[idx]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    queueMicrotask(() => document.querySelector('.pal [aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={close}>
  <div class="pal glass" role="dialog" tabindex="-1" aria-modal="true" aria-label="Command palette" onclick={(e) => e.stopPropagation()}>
    <div class="in">
      <Icon name="search" size={18} />
      <input bind:this={input} bind:value={q} onkeydown={onkey} placeholder="Jump to a storm, search a city, toggle a layer…" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-activedescendant="pal-{idx}" autocomplete="off" spellcheck="false" />
      {#if searching}<span class="dot"></span>{/if}
      <kbd>esc</kbd>
    </div>
    <ul id="pal-list" role="listbox">
      {#each results as it, i (it.id)}
        {#if i === 0 || results[i - 1]!.group !== it.group}<li class="grp" role="presentation">{it.group}</li>{/if}
        <li id="pal-{i}" role="option" aria-selected={i === idx} class:sel={i === idx} onmouseenter={() => (idx = i)} onclick={() => choose(it)}>
          {#if it.color}<i style="background:{it.color}"></i>{/if}
          <span class="lb">{it.label}</span>
          {#if it.hint}<span class="ht tnum">{it.hint}</span>{/if}
        </li>
      {:else}
        <li class="empty" role="presentation">No matches</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(2, 5, 12, 0.55); z-index: 50; display: flex; justify-content: center; align-items: flex-start; padding-top: min(14vh, 120px); }
  .pal { width: min(560px, calc(100vw - 24px)); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden; background: var(--glass-strong); }
  .in { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); color: var(--text-dim); }
  input { flex: 1; background: none; border: 0; outline: none; font-size: 16px; color: var(--text); min-width: 0; }
  ul { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
  li { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 9px; cursor: pointer; }
  li.sel { background: rgba(94, 224, 255, 0.12); }
  li.grp { cursor: default; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--text-faint); padding: 10px 12px 4px; font-weight: 600; }
  li.empty { color: var(--text-faint); cursor: default; }
  i { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .lb { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ht { color: var(--text-faint); font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: b 0.8s infinite alternate; }
  @keyframes b { to { opacity: 0.2; } }
</style>
