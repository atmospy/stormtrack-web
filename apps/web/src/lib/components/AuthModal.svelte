<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { auth } from '#lib/auth/auth.svelte';
  import { googleNativeAvailable, mountGoogleButton } from '#lib/auth/google';

  let email = $state('');
  let sent = $state(false);
  let err = $state('');
  let providers = $state<Set<string> | null>(null);
  $effect(() => { auth.enabledProviders().then((p) => (providers = p)); });
  const on = (id: string) => providers === null || providers.has(id);

  // Google's own button when it can be loaded; the redirect button below stays as the fallback
  let gEl = $state<HTMLElement | null>(null);
  let gNative = $state(false);
  $effect(() => {
    if (!gEl || !googleNativeAvailable() || !auth.configured || !on('google')) return;
    mountGoogleButton(gEl, async (credential, nonce) => {
      err = '';
      const r = await auth.signInWithGoogleCredential(credential, nonce);
      if (r.ok) close();
      else err = r.message;
    })
      .then(() => (gNative = true))
      .catch(() => (gNative = false));
  });
  const close = () => (app.authOpen = false);

  async function magic(e: SubmitEvent) {
    e.preventDefault();
    err = '';
    const r = await auth.signInWithEmail(email.trim());
    if (r.ok) sent = true;
    else err = r.message;
  }
  async function google() {
    err = '';
    const r = await auth.signInWithGoogle();
    if (!r.ok) err = r.message;
  }
  async function github() {
    err = '';
    const r = await auth.signInWithProvider('github');
    if (!r.ok) err = r.message;
  }
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={key} />
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim" onclick={close}>
  <div class="m glass" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="auth-t" onclick={(e) => e.stopPropagation()}>
    <button class="btn ghost icon x" onclick={close} aria-label="Close"><Icon name="close" size={16} /></button>
    <h2 id="auth-t">Create a free account</h2>
    <p class="lead">Save places and views, follow storms and unlock analysis exports.</p>

    {#if !auth.configured}
      <div class="demo" role="note">
        <b>Demo mode.</b> Authentication is not configured on this deployment (<code>PUBLIC_SUPABASE_URL</code> / <code>PUBLIC_SUPABASE_ANON_KEY</code> are empty). The whole map works without an account; sign-in actions are disabled here.
      </div>
    {/if}

    {#if sent}
      <div class="ok" role="status">Check <b>{email}</b> for a sign-in link. You can close this window.</div>
    {:else}
      {#if on('google') && googleNativeAvailable() && auth.configured}<div class="gbtn" bind:this={gEl} hidden={!gNative}></div>{/if}
      {#if on('google') && !gNative}<button class="btn g" onclick={google} disabled={!auth.configured || auth.busy}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.4-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1-3.7 1-2.8 0-5.2-1.9-6-4.5H2.4v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M6 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.4a11 11 0 0 0 0 9.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.1 1.600l3.100-3.100A11 11 0 0 0 2.400 7.100L6 9.900c.8-2.600 3.200-4.500 6-4.500z"/></svg>
        Continue with Google
      </button>{/if}
      {#if on('github')}<button class="btn gh" onclick={github} disabled={!auth.configured || auth.busy}>
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0a8 8 0 0 0-2.5 15.6c.4.1.5-.2.5-.4v-1.4c-2.200.5-2.700-1-2.700-1-.4-.9-.9-1.200-.9-1.200-.7-.5.100-.5.100-.5.800.100 1.200.8 1.200.8.700 1.200 1.900.9 2.300.7.100-.5.300-.9.500-1.100-1.800-.2-3.600-.9-3.600-4 0-.9.300-1.600.8-2.100-.1-.2-.4-1 .1-2.100 0 0 .7-.2 2.200.8a7.500 7.500 0 0 1 4 0c1.500-1 2.200-.8 2.200-.8.400 1.100.2 1.900.1 2.100.5.600.8 1.300.8 2.100 0 3.100-1.900 3.800-3.600 4 .3.300.5.800.5 1.500v2.200c0 .2.100.5.600.4A8 8 0 0 0 8 0z"/></svg>
        Continue with GitHub
      </button>{/if}
      {#if on('google') || on('github')}<div class="or"><span>or</span></div>{/if}
      <form onsubmit={magic}>
        <label for="em" class="sr-only">Email</label>
        <input id="em" type="email" required placeholder="you@example.com" bind:value={email} disabled={!auth.configured} autocomplete="email" />
        <button class="btn primary" disabled={!auth.configured || auth.busy}>Email me a magic link</button>
      </form>
      {#if err}<p class="err" role="alert">{err}</p>{/if}
    {/if}
    <p class="fine">By continuing you agree to the <a href="/terms" target="_blank" rel="noopener">terms</a> and the <a href="/privacy" target="_blank" rel="noopener">privacy policy</a>. This is an early preview. The account stores your email and what you choose to save.</p>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; background: rgba(2, 5, 12, 0.6); z-index: 60; display: grid; place-items: center; padding: 12px; }
  .m { width: min(400px, 100%); padding: 26px 24px 20px; position: relative; background: var(--glass-strong); }
  .x { position: absolute; top: 10px; right: 10px; }
  h2 { margin: 0 0 4px; font-size: 20px; }
  .lead { color: var(--text-dim); margin: 0 0 16px; }
  .demo { font-size: 12.5px; color: #ffd9a0; background: rgba(255, 176, 59, 0.09); border: 1px solid rgba(255, 176, 59, 0.3); padding: 10px 12px; border-radius: 10px; margin-bottom: 14px; }
  code { font-family: var(--mono); font-size: 11px; }
  .g { width: 100%; background: #fff; color: #1b1f2a; border-color: #fff; font-weight: 600; }
  .g:hover { background: #f1f4fb; }
  .gh { width: 100%; margin-top: 8px; background: #24292f; color: #fff; border-color: #444c56; font-weight: 600; }
  .gh:hover { background: #2f363d; }
  .or { display: flex; align-items: center; gap: 10px; color: var(--text-faint); font-size: 12px; margin: 14px 0; }
  .or::before, .or::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
  form { display: grid; gap: 10px; }
  input { background: rgba(255, 255, 255, 0.05); border: 1px solid var(--line-strong); border-radius: 9px; padding: 10px 12px; color: var(--text); }
  input:disabled { opacity: 0.5; }
  .ok { background: rgba(61, 224, 176, 0.1); border: 1px solid rgba(61, 224, 176, 0.35); padding: 12px; border-radius: 10px; }
  .err { color: var(--danger); font-size: 13px; margin: 10px 0 0; }
  .fine { font-size: 11px; color: var(--text-faint); margin: 16px 0 0; }
  .fine a { color: var(--text-dim); }
  .gbtn { display: flex; justify-content: center; min-height: 40px; }
  .gbtn[hidden] { display: none; }
</style>
