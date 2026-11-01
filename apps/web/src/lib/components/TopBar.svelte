<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { auth } from '#lib/auth/auth.svelte';
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
</script>

<header class="bar">
  <a class="brand glass" href="/" aria-label="StormTrack home">
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="#5ee0ff" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="16" cy="16" r="3" /><path d="M16 5.5c6.5 0 10.5 5 9.5 10" /><path d="M16 26.5c-6.5 0-10.5-5-9.5-10" /></svg>
    <span>StormTrack</span>
  </a>
  <button class="search glass" onclick={() => (app.paletteOpen = true)} aria-label="Open command palette">
    <Icon name="search" size={16} />
    <span class="ph">Search storms, places, layers</span>
    <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
  </button>
  <div class="right">
    {#if !auth.configured}<span class="demo glass" title="Authentication is not configured on this deployment">DEMO MODE</span>{/if}
    {#if auth.signedIn}
      <button class="user glass" onclick={() => auth.signOut()} title="Sign out" aria-label="Sign out of {auth.user?.email}">
        <Icon name="user" size={16} /><span class="email">{auth.user?.email ?? 'Account'}</span>
      </button>
    {:else}
      <button class="btn primary signin" onclick={() => (app.authOpen = true)}>Sign in</button>
    {/if}
  </div>
</header>

<style>
  .bar { position: absolute; top: calc(var(--gap) + env(safe-area-inset-top, 0px)); left: var(--gap); right: 56px; display: flex; gap: var(--gap); align-items: center; z-index: 5; pointer-events: none; }
  .bar > * { pointer-events: auto; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 8px 14px; font-weight: 700; letter-spacing: 0.02em; color: var(--text); height: 40px; }
  .brand:hover { text-decoration: none; }
  .search { display: flex; align-items: center; gap: 10px; padding: 0 12px; height: 40px; width: min(380px, 40vw); color: var(--text-dim); text-align: left; }
  .search:hover { border-color: var(--line-strong); color: var(--text); }
  .ph { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .demo { font-size: 10.5px; letter-spacing: 0.12em; padding: 6px 10px; color: var(--warn); border-color: rgba(255, 176, 59, 0.4); font-weight: 700; }
  .user { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 40px; color: var(--text-dim); }
  .email { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .signin { height: 40px; white-space: nowrap; }
  @media (max-width: 720px) {
    .bar { right: 56px; gap: 8px; }
    .brand span { display: none; }
    .brand { padding: 8px 10px; }
    .search { flex: 1; width: auto; }
    kbd, .email, .demo { display: none; }
    .signin { padding: 0 12px; }
  }
</style>
