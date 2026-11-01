/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />
/**
 * Minimal and safe service worker.
 *  - Run-stamped weather frames (`.../<YYYYMMDDTHH>/.../fFFF.png`) are immutable -> cache-first.
 *  - Hashed app assets (`/_app/immutable/`) are immutable -> cache-first.
 *  - Pointer / data JSON (`index.json`, `latest.json`, `*.geojson`, `flashes.json`...) can change at any time ->
 *    stale-while-revalidate (instant from cache, refreshed in the background). They are NEVER cache-first.
 *  - Everything else (HTML, tiles, third-party) is left to the network untouched.
 * Caches are versioned: a new deploy (`version`) drops every old `stormtrack-*` cache on activate.
 */
import { version } from '$app/env';

declare const self: ServiceWorkerGlobalScope;

const APP = `stormtrack-app-${version}`;
const DATA = 'stormtrack-data-v1';
const MAX_DATA_ENTRIES = 600; // ~0.5 MB each at 0.5 deg: bounded to a few hundred MB worst case, usually far less

const RUN_STAMPED_FRAME = /\/\d{8}T\d{2}\/.+\.png$/;
const POINTER = /\.(json|geojson)$/;

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('stormtrack-') && k !== APP && k !== DATA) await caches.delete(k);
      await self.clients.claim();
    })()
  );
});

async function trim(cache: Cache): Promise<void> {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_DATA_ENTRIES; i++) await cache.delete(keys[i]!);
}

const cacheable = (res: Response) => res.ok && res.status === 200 && (res.type === 'basic' || res.type === 'cors');

async function cacheFirst(req: Request, name: string, limit: boolean): Promise<Response> {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) {
    await cache.put(req, res.clone());
    if (limit) void trim(cache);
  }
  return res;
}

async function staleWhileRevalidate(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(DATA);
  const hit = await cache.match(event.request);
  const refresh = fetch(event.request).then(async (res) => {
    // never keep an HTML SPA fallback (a missing JSON file answered with 200 + index.html) as if it were data
    if (cacheable(res) && !(res.headers.get('content-type') ?? '').includes('text/html')) await cache.put(event.request, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => undefined));
    return hit;
  }
  return refresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && url.pathname.includes('/_app/immutable/')) {
    event.respondWith(cacheFirst(req, APP, false));
  } else if (RUN_STAMPED_FRAME.test(url.pathname)) {
    event.respondWith(cacheFirst(req, DATA, true));
  } else if (POINTER.test(url.pathname) && /\/(data|weather|wind|storms|hazards|lightning)\//.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event));
  }
});
