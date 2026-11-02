import { AUTH_CONFIGURED } from '#lib/config';
import { getSupabase, mayHaveSession } from './client';
import { toast } from '#lib/stores/toast.svelte';

export type AuthResult = { ok: true } | { ok: false; reason: 'demo' | 'signed-out' | 'error'; message: string };

interface MinimalUser {
  id: string;
  email?: string | null;
}

const DEMO: AuthResult = { ok: false, reason: 'demo', message: 'Demo mode: authentication is not configured on this deployment.' };

class AuthStore {
  /** false means the clearly-labelled demo mode */
  readonly configured = AUTH_CONFIGURED;
  user = $state<MinimalUser | null>(null);
  ready = $state(!AUTH_CONFIGURED);
  follows = $state<Set<string>>(new Set());
  busy = $state(false);

  get signedIn(): boolean {
    return this.user !== null;
  }

  /** Call once on startup; only loads supabase-js eagerly when a session may exist. */
  init(): void {
    if (!this.configured) return;
    if (!mayHaveSession()) {
      this.ready = true;
      return;
    }
    void this.attach();
  }

  private async attach(): Promise<void> {
    try {
      const sb = await getSupabase();
      const { data } = await sb.auth.getSession();
      this.user = data.session?.user ?? null;
      sb.auth.onAuthStateChange((_e, session) => {
        this.user = session?.user ?? null;
        if (this.user) void this.loadFollows();
        else this.follows = new Set();
      });
      if (this.user) void this.loadFollows();
    } catch (e) {
      console.warn('auth init failed', e);
    } finally {
      this.ready = true;
    }
  }

  async ensureAttached(): Promise<void> {
    if (!this.configured) return;
    await this.attach();
  }

  async signInWithEmail(email: string): Promise<AuthResult> {
    if (!this.configured) return DEMO;
    this.busy = true;
    try {
      const sb = await getSupabase();
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
      return error ? { ok: false, reason: 'error', message: error.message } : { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error', message: (e as Error).message };
    } finally {
      this.busy = false;
    }
  }

  async signInWithProvider(provider: 'google' | 'github'): Promise<AuthResult> {
    if (!this.configured) return DEMO;
    this.busy = true;
    try {
      const sb = await getSupabase();
      const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: location.origin + location.pathname } });
      return error ? { ok: false, reason: 'error', message: error.message } : { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error', message: (e as Error).message };
    } finally {
      this.busy = false;
    }
  }

  signInWithGoogle(): Promise<AuthResult> {
    return this.signInWithProvider('google');
  }

  /** Which OAuth providers the Supabase project has switched on (public settings endpoint). */
  async enabledProviders(): Promise<Set<string> | null> {
    if (!this.configured) return null;
    try {
      const base = (import.meta.env.PUBLIC_SUPABASE_URL as string).replace(/\/$/, '');
      const r = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string } });
      if (!r.ok) return null;
      const ext = (await r.json()).external ?? {};
      return new Set(Object.keys(ext).filter((k) => ext[k]));
    } catch {
      return null; // unknown: show every button rather than hide a working one
    }
  }

  async signOut(): Promise<void> {
    if (!this.configured) return;
    const sb = await getSupabase();
    await sb.auth.signOut();
    this.user = null;
    this.follows = new Set();
  }

  private guard(): AuthResult | null {
    if (!this.configured) return DEMO;
    if (!this.user) return { ok: false, reason: 'signed-out', message: 'Sign in to use this feature.' };
    return null;
  }

  /** public.saved_places (CONTRACTS 4) */
  async savePlace(name: string, lat: number, lon: number): Promise<AuthResult> {
    const g = this.guard();
    if (g) return g;
    const sb = await getSupabase();
    const { error } = await sb.from('saved_places').insert({ user_id: this.user!.id, name, lat, lon });
    return error ? { ok: false, reason: 'error', message: error.message } : { ok: true };
  }

  /** public.saved_views (CONTRACTS 4) */
  async saveView(name: string, state: Record<string, unknown>): Promise<AuthResult> {
    const g = this.guard();
    if (g) return g;
    const sb = await getSupabase();
    const { error } = await sb.from('saved_views').insert({ user_id: this.user!.id, name, state });
    return error ? { ok: false, reason: 'error', message: error.message } : { ok: true };
  }

  async loadFollows(): Promise<void> {
    if (!this.user) return;
    const sb = await getSupabase();
    const { data, error } = await sb.from('storm_follows').select('storm_id');
    if (!error && data) this.follows = new Set(data.map((r: { storm_id: string }) => r.storm_id));
  }

  isFollowing(id: string): boolean {
    return this.follows.has(id);
  }

  /** public.storm_follows (CONTRACTS 4) */
  async toggleFollow(stormId: string): Promise<AuthResult> {
    const g = this.guard();
    if (g) return g;
    const sb = await getSupabase();
    const following = this.follows.has(stormId);
    const q = following
      ? sb.from('storm_follows').delete().eq('user_id', this.user!.id).eq('storm_id', stormId)
      : sb.from('storm_follows').insert({ user_id: this.user!.id, storm_id: stormId });
    const { error } = await q;
    if (error) return { ok: false, reason: 'error', message: error.message };
    const next = new Set(this.follows);
    if (following) next.delete(stormId);
    else next.add(stormId);
    this.follows = next;
    toast.show(following ? 'Unfollowed storm' : 'Following storm');
    return { ok: true };
  }
}

export const auth = new AuthStore();
