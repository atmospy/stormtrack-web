import { SondeBook, parseSonde, sondeGeoJSON } from './parse';

const SNAPSHOT = 'https://api.v2.sondehub.org/sondes?last=3600';
const FEED = 'wss://ws-reader.v2.sondehub.org/';
const PUSH_MS = 2000;

/**
 * Live radiosondes from SondeHub. Nothing is requested until the layer is switched on: then one snapshot of the
 * last hour (a single small request) and the network's own websocket feed, which is the access they ask for in place
 * of polling. The connection is closed when the layer is switched off.
 */
class Sondes {
  status = $state<'off' | 'connecting' | 'live' | 'error'>('off');
  count = $state(0);
  private book = new SondeBook();
  private client: { end(force?: boolean): void } | null = null;
  private timer = 0;
  private sink: ((g: ReturnType<typeof sondeGeoJSON>) => void) | null = null;

  /** the map module registers where to draw */
  onData(fn: (g: ReturnType<typeof sondeGeoJSON>) => void): void {
    this.sink = fn;
  }

  private push(): void {
    this.book.prune(Date.now());
    this.count = this.book.last.size;
    this.sink?.(sondeGeoJSON(this.book, Date.now()));
  }

  async start(): Promise<void> {
    if (this.status !== 'off' && this.status !== 'error') return;
    this.status = 'connecting';
    try {
      const [{ default: mqtt }, snap] = await Promise.all([import('mqtt'), fetch(SNAPSHOT).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))]);
      if (this.status !== 'connecting') return; // switched off while loading
      for (const v of Object.values(snap as Record<string, unknown>)) {
        const f = parseSonde(v);
        if (f) this.book.add(f);
      }
      this.push();
      const c = mqtt.connect(FEED, { protocolVersion: 4, reconnectPeriod: 5000, connectTimeout: 10_000 });
      this.client = c;
      c.on('connect', () => {
        this.status = 'live';
        c.subscribe('sondes/#');
      });
      c.on('message', (_t: string, payload: Uint8Array) => {
        try {
          const f = parseSonde(JSON.parse(new TextDecoder().decode(payload)));
          if (f) this.book.add(f);
        } catch {
          /* ignore a malformed packet */
        }
      });
      c.on('error', () => {
        if (this.status !== 'live') this.status = 'error';
      });
      this.timer = window.setInterval(() => this.push(), PUSH_MS);
    } catch (e) {
      console.warn('sondes unavailable', e);
      this.status = 'error';
    }
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.client?.end(true);
    this.client = null;
    this.status = 'off';
  }
}

export const sondes = new Sondes();
