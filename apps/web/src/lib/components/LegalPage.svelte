<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, updated, children }: { title: string; updated: string; children: Snippet } = $props();
</script>

<svelte:head><title>{title} · StormTrack</title></svelte:head>

<div class="page">
  <article>
    <a class="back" href="/">&larr; Back to the map</a>
    <h1>{title}</h1>
    <p class="meta">Last updated {updated}</p>
    {@render children()}
    <footer>
      <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · StormTrack is an early preview by AtmosPy.
    </footer>
  </article>
</div>

<style>
  .page { position: fixed; inset: 0; overflow-y: auto; background: var(--bg); color: var(--text); }
  article { max-width: 44rem; margin: 0 auto; padding: 32px 20px 64px; font-size: 15px; line-height: 1.65; }
  .back { font-size: 13px; color: var(--text-dim); text-decoration: none; }
  .back:hover { color: var(--text); }
  h1 { font-size: 28px; line-height: 1.2; margin: 18px 0 4px; }
  .meta { color: var(--text-faint); font-size: 13px; margin: 0 0 24px; }
  article :global(h2) { font-size: 18px; margin: 30px 0 6px; }
  article :global(p), article :global(ul) { margin: 8px 0; color: var(--text-dim); }
  article :global(li) { margin: 4px 0; }
  article :global(a) { color: var(--accent, #7cc4ff); }
  article :global(b) { color: var(--text); }
  footer { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.1)); font-size: 12.5px; color: var(--text-faint); }
</style>
