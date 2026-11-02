/** Central runtime configuration. Everything tunable lives here. */

const env = import.meta.env as Record<string, string | undefined>;

/** Where the data products live (wind/, storms/, hazards/). No trailing slash. */
export const DATA_BASE = (env.PUBLIC_DATA_BASE || '/data').replace(/\/+$/, '');
/** Committed sample data, used automatically when the real file is missing. */
export const SAMPLE_BASE = '/data/sample';

export const SUPABASE_URL = env.PUBLIC_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = env.PUBLIC_SUPABASE_ANON_KEY || '';
/** Where people can reach the operator about privacy requests. Empty until set; the legal pages then say so. */
export const CONTACT_EMAIL = env.PUBLIC_CONTACT_EMAIL || '';
export const AUTH_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Login gate (CONTRACTS section 5). */
export const GATE = {
  /** Active (tab visible) time before the sign-up card is shown. */
  activeMs: 3 * 60_000,
  /** Meaningful interactions (layer toggle, storm click, search, scrub). */
  interactions: 8,
  /** "Not now" snooze. */
  snoozeMs: 24 * 3600_000,
  storageKey: 'stormtrack.gate.snoozeUntil'
} as const;

export const MAP = {
  openFreeMapTiles: 'https://tiles.openfreemap.org/planet',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  initialCenter: [80, 18] as [number, number],
  initialZoom: 1.3
} as const;

/** Frame playback */
export const PLAYBACK = { stepMs: 1100, preloadAhead: 2, cacheSize: 6 } as const;
