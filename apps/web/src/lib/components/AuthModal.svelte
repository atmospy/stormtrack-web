<script lang="ts">
  import Icon from './Icon.svelte';
  import { app } from '#lib/stores/app.svelte';
  import { auth } from '#lib/auth/auth.svelte';

  let email = $state('');
  let sent = $state(false);
  let err = $state('');
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
      <button class="btn g" onclick={google} disabled={!auth.configured || auth.busy}>
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.4-1 7.2-2.7l-3.5-2.7c-1 .7-2.2 1-3.7 1-2.8 0-5.2-1.9-6-4.5H2.4v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M6 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.4a11 11 0 0 0 0 9.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.1 1.600l3.100-3.100A11 11 0 0 0 2.400 7.100L6 9.900c.8-2.600 3.200-4.500 6-4.500z"/></svg>
        Continue with Google
      </button>
      <div class="or"><span>or</span></div>
      <form onsubmit={magic}>
        <label for="em" class="sr-only">Email</label>
        <input id="em" type="email" required placeholder="you@example.com" bind:value={email} disabled={!auth.configured} autocomplete="email" />
        <button class="btn primary" disabled={!auth.configured || auth.busy}>Email me a magic link</button>
      </form>
      {#if err}<p class="err" role="alert">{err}</p>{/if}
    {/if}
    <p class="fine">By continuing you agree this is an early preview. The account only stores what you choose to save.</p>
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
  .or { display: flex; align-items: center; gap: 10px; color: var(--text-faint); font-size: 12px; margin: 14px 0; }
  .or::before, .or::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
  form { display: grid; gap: 10px; }
  input { background: rgba(255, 255, 255, 0.05); border: 1px solid var(--line-strong); border-radius: 9px; padding: 10px 12px; color: var(--text); }
  input:disabled { opacity: 0.5; }
  .ok { background: rgba(61, 224, 176, 0.1); border: 1px solid rgba(61, 224, 176, 0.35); padding: 12px; border-radius: 10px; }
  .err { color: var(--danger); font-size: 13px; margin: 10px 0 0; }
  .fine { font-size: 11px; color: var(--text-faint); margin: 16px 0 0; }
</style>
