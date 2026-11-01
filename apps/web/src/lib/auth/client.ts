import { AUTH_CONFIGURED, SUPABASE_ANON_KEY, SUPABASE_URL } from '#lib/config';
import type { SupabaseClient } from '@supabase/supabase-js';

let clientPromise: Promise<SupabaseClient> | null = null;

/** Lazily import supabase-js (it is not part of the initial bundle). */
export function getSupabase(): Promise<SupabaseClient> {
  if (!AUTH_CONFIGURED) return Promise.reject(new Error('Supabase is not configured'));
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } })
  );
  return clientPromise;
}

/** Cheap check (no import) for whether a session may exist, so we only load supabase-js when useful. */
export function mayHaveSession(): boolean {
  try {
    if (/[?&#](code|access_token|error_description)=/.test(location.search + location.hash)) return true;
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith('sb-')) return true;
  } catch {
    /* storage blocked */
  }
  return false;
}
