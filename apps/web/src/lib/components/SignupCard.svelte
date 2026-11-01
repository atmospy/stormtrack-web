<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { gate } from '#lib/stores/gate.svelte';
  import { auth } from '#lib/auth/auth.svelte';
</script>

<aside class="card glass" aria-label="Create an account">
  <div class="t">Create a free account</div>
  <p>Save places, follow storms and unlock analysis.{#if !auth.configured} <em>(demo mode: sign-in not configured)</em>{/if}</p>
  <div class="a">
    <button class="btn primary" onclick={() => { gate.dismiss(); app.authOpen = true; }}><Icon name="user" size={14} />Sign up</button>
    <button class="btn ghost" onclick={() => gate.dismiss()}>Not now</button>
  </div>
</aside>

<style>
  .card { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(var(--timebar-h) + var(--gap) * 2 + var(--safe-b)); width: min(420px, calc(100vw - 2 * var(--gap))); padding: 14px 16px; z-index: 8; animation: up 0.35s ease-out; border-color: rgba(94, 224, 255, 0.35); box-shadow: var(--shadow), var(--glow); }
  @keyframes up { from { opacity: 0; transform: translate(-50%, 14px); } }
  .t { font-weight: 700; font-size: 15px; }
  p { margin: 4px 0 12px; color: var(--text-dim); font-size: 13px; }
  em { color: var(--warn); font-style: normal; }
  .a { display: flex; gap: 8px; }
</style>
