# infra/

| file | purpose |
|---|---|
| `cloudflare/wrangler.toml` | Pages project name / output dir |
| `cloudflare/r2-cors.json` | R2 bucket CORS (`wrangler r2 bucket cors set <bucket> --file infra/cloudflare/r2-cors.json`) |
| `cloudflare/cache-control.json` | Cache-Control + Content-Type the ingest jobs must set per R2 key pattern |
| `cloudflare/_headers` | Security + caching headers for the static app; A copies to `apps/web/static/_headers` (CI falls back to copying it into the build) |
| `render/render.yaml` | Render Blueprint for `services/api` |

## Threat notes: CORS and rate limiting

* **R2 data CORS is `GET`/`HEAD` only and origin-allow-listed.** The data is public, so CORS is
  not a confidentiality control; it stops other sites from hot-linking our bandwidth *in
  browsers* and keeps credentials out of the picture (never enable `Access-Control-Allow-Credentials`
  or `*` together with cookies). Hot-linking by non-browser clients is still possible; the
  mitigation for that is Cloudflare WAF rate limiting / Hotlink Protection on the data hostname.
* **R2 costs are egress-free but Class-B (read) operations are metered** (free tier 10 M/month).
  Serve through the custom domain with the cache headers above so >95 % of hits are CDN hits
  that never reach R2; add a Cloudflare rate-limiting rule (e.g. 300 req/min/IP on the data
  host) as a cheap abuse brake.
* **API (Render)** must use an exact-origin CORS allow-list (`CORS_ORIGINS`), never `*` with
  credentials, and rate-limit per IP (and per user id when a JWT is present) in the app and/or
  at Cloudflare in front of it. Validate every parameter (basin codes, storm ids against the
  `^[A-Za-z0-9._-]{1,40}$` pattern the DB uses, date ranges) and cap response sizes; expensive
  analysis endpoints should require a Supabase JWT, verified server-side.
* **Supabase** is called straight from the browser with the anon key, so RLS is the only
  barrier: see `supabase/migrations`. Rate limits for auth are in the dashboard (docs/DEPLOY.md).
