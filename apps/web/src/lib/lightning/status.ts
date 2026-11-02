import type { FeedHealth } from './poller';

export type BadgeTone = 'live' | 'demo' | 'stale' | 'offline' | 'missing' | 'connecting';

/** "5 s", "2 min", "3.5 h": honest, compact age text */
export function fmtDuration(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** The delay as shown to users: "1.7 min" (CONTRACTS 6.2: show it honestly). */
export const fmtDelay = (delayS: number): string => (delayS < 90 ? `${Math.round(delayS)} s` : `${(delayS / 60).toFixed(1)} min`);

/** Badge text for the feed state. Never claims better than the truth. */
export function feedBadge(h: FeedHealth, delayS: number): { text: string; tone: BadgeTone; title: string } {
  switch (h.kind) {
    case 'live':
      return { text: `LIVE · ≈${fmtDelay(delayS)} behind`, tone: 'live', title: `Strikes are played ${fmtDelay(delayS)} after they happen so every batch has arrived. Newest data is ${h.ageS === null ? '?' : fmtDuration(h.ageS)} old.` };
    case 'demo':
      return { text: 'DEMO · simulated storms', tone: 'demo', title: 'Every strike is simulated. This is not real lightning.' };
    case 'stale':
      return { text: `STALE · feed ${h.ageS === null ? '?' : fmtDuration(h.ageS)} old`, tone: 'stale', title: 'The lightning feed has stopped updating. What you see is old.' };
    case 'offline':
      return { text: 'OFFLINE · cannot reach the feed', tone: 'offline', title: 'The feed could not be fetched several times in a row; retrying with back-off.' };
    case 'missing':
      return { text: 'NO LIVE FEED published', tone: 'missing', title: 'recent.json is not available here. Try the demo.' };
    default:
      return { text: 'Connecting…', tone: 'connecting', title: '' };
  }
}
