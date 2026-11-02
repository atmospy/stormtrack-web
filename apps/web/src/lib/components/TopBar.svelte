<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { auth } from '#lib/auth/auth.svelte';
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
</script>

<header class="bar">
  <a class="brand" href="/" aria-label="StormTrack home">
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" stroke="url(#stm)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <defs><linearGradient id="stm" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse"><stop stop-color="#22d3ee"/><stop offset=".55" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
      <path d="M16.00 10.80 L17.07 10.08 L18.35 9.70 L19.78 9.64 L21.27 9.92 L22.76 10.55 L24.17 11.54 L25.41 12.87 L26.41 14.51 L27.11 16.40 L27.43 18.50 L27.34 20.71 L26.81 22.96 L25.82 25.16 L24.38 27.22 M11.50 18.60 L10.34 18.04 L9.37 17.11 L8.60 15.91 L8.10 14.47 L7.90 12.87 L8.06 11.15 L8.59 9.41 L9.50 7.73 L10.80 6.18 L12.45 4.85 L14.41 3.82 L16.62 3.16 L19.02 2.91 L21.52 3.14 M20.50 18.60 L20.59 19.89 L20.28 21.19 L19.62 22.45 L18.63 23.61 L17.33 24.58 L15.77 25.30 L14.00 25.71 L12.09 25.76 L10.10 25.42 L8.12 24.65 L6.25 23.47 L4.56 21.88 L3.15 19.93 L2.10 17.65"/><circle cx="16" cy="16" r="1.6" fill="#e0f7ff" stroke="none"/>
    </svg>
    <span class="wm"><b>Storm</b>Track</span>
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
      <button class="btn outline signin" onclick={() => (app.authOpen = true)}>Sign in</button>
    {/if}
  </div>
</header>

<style>
  .bar { position: absolute; top: calc(var(--gap) + env(safe-area-inset-top, 0px)); left: var(--gap); right: 56px; display: flex; gap: var(--gap); align-items: center; z-index: 5; pointer-events: none; }
  .bar > * { pointer-events: auto; }
  .brand { display: flex; align-items: center; gap: 9px; padding: 0 6px 0 2px; color: var(--text); height: 40px; }
  .wm { font-family: var(--font-display); font-size: 19px; font-weight: 300; letter-spacing: 0.01em; }
  .wm b { font-weight: 600; }
  .brand:hover { text-decoration: none; }
  .search { display: flex; align-items: center; gap: 10px; padding: 0 12px; height: 38px; width: min(380px, 40vw); color: var(--text-dim); text-align: left; }
  .search:hover { border-color: var(--line-strong); color: var(--text); }
  .ph { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
  .demo { font-size: 10.5px; letter-spacing: 0.12em; padding: 6px 10px; color: var(--warn); border-color: rgba(255, 176, 59, 0.4); font-weight: 700; }
  .user { display: flex; align-items: center; gap: 8px; padding: 0 12px; height: 40px; color: var(--text-dim); }
  .email { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .signin { height: 40px; white-space: nowrap; }
  @media (max-width: 720px) {
    .bar { right: 56px; gap: 8px; }
    .wm { display: none; }
    .search { flex: 1; width: auto; }
    kbd, .email, .demo { display: none; }
    .signin { padding: 0 12px; }
  }
</style>
