/**
 * Sign in with Google's own button (Google Identity Services), then hand the ID token to Supabase.
 *
 * Why: with the redirect flow Google's consent screen names the Supabase project address. With this flow the
 * browser gets an ID token directly, so Google shows the app's own name and origin. The script is loaded only
 * when the sign-in dialog opens, and the redirect button stays as the fallback if anything here fails.
 */
import { GOOGLE_CLIENT_ID } from '#lib/config';

const SRC = 'https://accounts.google.com/gsi/client';

interface GsiId {
  initialize(cfg: Record<string, unknown>): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
}
type GoogleWindow = Window & { google?: { accounts?: { id?: GsiId } } };

export const googleNativeAvailable = (): boolean => GOOGLE_CLIENT_ID !== '';

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 128 random bits as hex; the raw value goes to Supabase, its SHA-256 goes to Google. */
export function randomNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

let loading: Promise<GsiId> | null = null;

export function loadGsi(timeoutMs = 5000): Promise<GsiId> {
  const have = (window as GoogleWindow).google?.accounts?.id;
  if (have) return Promise.resolve(have);
  loading ??= new Promise<GsiId>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    const timer = setTimeout(() => fail(new Error('Google sign-in script timed out')), timeoutMs);
    const fail = (e: Error) => {
      clearTimeout(timer);
      loading = null; // allow a later retry
      s.remove();
      reject(e);
    };
    s.onload = () => {
      clearTimeout(timer);
      const id = (window as GoogleWindow).google?.accounts?.id;
      id ? resolve(id) : fail(new Error('Google sign-in script loaded without its API'));
    };
    s.onerror = () => fail(new Error('Google sign-in script could not be loaded'));
    document.head.append(s);
  });
  return loading;
}

/** Renders Google's button into `el`. `onCredential` receives the ID token and the raw nonce to pass to Supabase. */
export async function mountGoogleButton(
  el: HTMLElement,
  onCredential: (credential: string, nonce: string) => void
): Promise<void> {
  const id = await loadGsi();
  const nonce = randomNonce();
  id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    nonce: await sha256Hex(nonce),
    callback: (r: { credential?: string }) => r.credential && onCredential(r.credential, nonce),
    use_fedcm_for_prompt: true,
    itp_support: true
  });
  id.renderButton(el, {
    type: 'standard',
    theme: 'filled_black',
    size: 'large',
    text: 'continue_with',
    shape: 'rectangular',
    logo_alignment: 'left',
    width: Math.max(200, Math.min(400, el.clientWidth || 320))
  });
}
