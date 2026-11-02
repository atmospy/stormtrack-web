# Deploying StormTrack Web

Runbook for the **owner**. Steps marked **[OWNER]** need your accounts or credentials; agents
and CI cannot do them. Everything else is automated by the workflows in `.github/workflows/`.

Architecture: static app on **Cloudflare Pages**; data files on **Cloudflare R2** (served from a
custom domain); users/auth on **Supabase**; scheduled ingest in **GitHub Actions**; optional
FastAPI on **Render**.

Placeholders used below: `GH_REPO=atmospy/stormtrack-web`, `DOMAIN=stormtrack.example`
(replace with your real domain; if you have none yet use the `*.pages.dev` URL and skip the
custom-domain steps).

---------------------------------------------------------------------------------------

## 0. First-run order (do in this order)

1. Create GitHub repo, push code. **[OWNER]**
2. Supabase project + migrations + auth config (section 1). **[OWNER]**
3. Cloudflare R2 bucket, CORS, token, custom data domain (section 2). **[OWNER]**
4. Cloudflare Pages project (section 3). **[OWNER]**
5. GitHub secrets + variables (section 4). **[OWNER]**
6. Run the ingest workflows manually once, wind/storms/hazards (section 5).
7. Merge to `main` -> `deploy-web.yml` publishes the site (section 3.3).
8. Add the production URL to Supabase redirect URLs, test sign-in (section 1.4).
9. Optional: Render API (section 6).

Why this order: the web build needs the Supabase URL/key and the data base URL (steps 2-3),
and the first deploy should find data already in R2 (step 6).

---------------------------------------------------------------------------------------

## 1. Supabase **[OWNER]**

### 1.1 Create the project
1. https://supabase.com/dashboard -> New project. Org: yours. Name `stormtrack`. Pick the
   region closest to most users. **Choose and save a strong database password** (-> `SUPABASE_DB_PASSWORD`).
2. Note the **project ref** (Settings -> General, a 20-char id) and, under Settings -> API
   (or "API Keys"): the **Project URL** and the **anon / publishable key**.
   (The `service_role` / secret key must never be put in the web app, the repo, or GitHub variables.)

### 1.2 Apply migrations (from your laptop, repo root)
```bash
brew install supabase/tap/supabase          # or: npm i -g supabase
supabase login                              # opens a browser
supabase link --project-ref <PROJECT_REF>   # asks for the DB password
supabase db push --dry-run                  # shows what will run
supabase db push                            # applies supabase/migrations/*.sql
```
`db push` never runs `seed.sql`; the seed is local-dev only.

Verify: Dashboard -> Table Editor shows `profiles`, `saved_places`, `saved_views`,
`storm_follows`, each with the "RLS enabled" badge; Authentication -> Policies lists four
policies (three for `storm_follows`) per table. Dashboard -> Advisors -> Security should report no
"RLS disabled" findings.

### 1.3 Auth settings (Dashboard -> Authentication)
**URL Configuration**
- Site URL: `https://DOMAIN` (or the `https://stormtrack-web.pages.dev` URL until you have one).
- Redirect URLs (exact entries; add each):
  - `https://DOMAIN/auth/callback`
  - `https://stormtrack-web.pages.dev/auth/callback`
  - `https://*.stormtrack-web.pages.dev/auth/callback` (Pages preview deployments)
  - `http://localhost:5173/auth/callback` (local dev)
  Keep this list tight; a loose wildcard such as `https://*` enables open-redirect token theft.
  (Path `/auth/callback` is what `config.toml` assumes; if workstream A uses another path, change both.)

**Sign In / Providers -> Email**: enabled; "Confirm email" on (magic links also confirm).
Set "Email OTP Expiration" to 900 s (matches local config). Leave password sign-in off unless the
app offers it.

**Google OAuth**
1. https://console.cloud.google.com -> create/select a project -> APIs & Services ->
   OAuth consent screen: External, app name, support email, authorized domain `DOMAIN`; scopes
   `openid`, `email`, `profile` only.
2. Credentials -> Create credentials -> OAuth client ID -> Web application.
   - Authorized JavaScript origins: `https://DOMAIN`, `https://stormtrack-web.pages.dev`, `http://localhost:5173`
   - Authorized redirect URI: `https://<PROJECT_REF>.supabase.co/auth/v1/callback`
     (exact value is shown in Supabase -> Authentication -> Providers -> Google)
3. Copy Client ID and Client secret into Supabase -> Providers -> Google -> enable -> Save.
4. Publish the consent screen ("In production") or only test users can sign in.

**Email templates** (Authentication -> Email Templates -> Magic Link and Confirm signup): set a
friendly subject ("Your StormTrack sign-in link"), keep `{{ .ConfirmationURL }}`, and put the
product name in the body. Do not add tracking pixels.

**SMTP / rate limits (important)**: the built-in mailer is limited to a few emails per hour
project-wide and is for testing only. Before launch configure custom SMTP
(Authentication -> SMTP Settings; e.g. Resend/Brevo free tier, with SPF/DKIM on your domain), then
Authentication -> Rate Limits: emails per hour ~30 to start, sign-ups/sign-ins per 5 min per IP
30 (default), token refresh 150. Enable **CAPTCHA** (Authentication -> Attack Protection ->
Cloudflare Turnstile, free) if you see sign-up abuse; this also needs a client-side token in the app.

### 1.4 Verify
- Open the site, request a magic link, click it, land signed in.
- Dashboard -> Authentication -> Users shows the user; Table Editor -> `profiles` has a row for
  them (created by trigger `on_auth_user_created`).
- SQL editor sanity check as anon (should fail with `permission denied`):
  `set role anon; select * from public.saved_places;`

---------------------------------------------------------------------------------------

## 2. Cloudflare R2 (data) **[OWNER]**

1. Dashboard -> R2 -> enable R2 (needs a payment method on file even for the free tier) -> Create
   bucket `stormtrack-data`, location hint nearest your users.
2. **Custom domain** (Bucket -> Settings -> Custom Domains -> Connect): `data.DOMAIN`. The domain's
   DNS must be on Cloudflare. Do not enable the public `r2.dev` URL for production (it is
   rate-limited and uncached); it is fine for a quick test.
3. **CORS**: from repo root,
   ```bash
   npx wrangler login
   npx wrangler r2 bucket cors set stormtrack-data --file infra/cloudflare/r2-cors.json
   npx wrangler r2 bucket cors list stormtrack-data
   ```
   Edit the origins in `infra/cloudflare/r2-cors.json` first so they match your real domain.
4. **API token for CI**: R2 -> Manage API tokens -> Create API token -> permission
   *Object Read & Write*, scoped to **only** `stormtrack-data`, no TTL (or set a calendar reminder).
   Record: Access Key ID, Secret Access Key (shown once), and your Account ID (R2 overview page).
5. **Cache behaviour**: ingest jobs must upload with the `Cache-Control` values in
   `infra/cloudflare/cache-control.json` (immutable for `wind/<run>/f*.png`, 60 s + SWR for pointer
   files). As a safety net add a Cloudflare **Cache Rule** for `data.DOMAIN`: *Cache eligibility:
   eligible; Edge TTL: use origin Cache-Control; Browser TTL: respect origin*.
6. **Abuse brake**: Security -> WAF -> Rate limiting rules: `data.DOMAIN`, 300 requests / 1 min per
   IP -> block 10 min (free plan allows one such rule).

Verify after the first ingest (section 5):
```bash
curl -sI https://data.DOMAIN/wind/latest.json | grep -i 'cache-control\|content-type\|access-control'
curl -s https://data.DOMAIN/wind/latest.json | head -c 300
curl -sI -H 'Origin: https://DOMAIN' https://data.DOMAIN/wind/latest.json | grep -i access-control-allow-origin
```

---------------------------------------------------------------------------------------

## 3. Cloudflare Pages (web) **[OWNER]**

### 3.1 Create the project (Direct Upload, because GitHub Actions builds it)
```bash
npx wrangler login
npx wrangler pages project create stormtrack-web --production-branch=main
```
(Or Dashboard -> Workers & Pages -> Create -> Pages -> Upload assets, project name `stormtrack-web`.)
Do **not** connect the Git integration as well; that would build twice.

### 3.2 API token for CI
My Profile -> API Tokens -> Create Token -> Custom: *Account -> Cloudflare Pages -> Edit*, scoped to
your account. Save it as `CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_ACCOUNT_ID` is on the dashboard
right sidebar.

### 3.3 First deploy and domain
After section 4 is done, run Actions -> "Deploy web (Cloudflare Pages)" -> Run workflow (branch `main`).
Result URL appears in the run summary. Production = pushes to `main`; PRs from this repository get
preview URLs (`<branch>.stormtrack-web.pages.dev`); PRs from forks are skipped (no secrets).

Custom domain: Pages project -> Custom domains -> Set up -> `DOMAIN` (and `www`). DNS on Cloudflare
makes this automatic.

### 3.4 Security headers
`infra/cloudflare/_headers` is shipped with every deploy (workstream A places it at
`apps/web/static/_headers`; CI copies it into the build if absent). The CSP is **Report-Only** at
first. Edit the two origins (data host and API host), deploy a preview, load the app with the
console open, and when there are no violations rename the header to `Content-Security-Policy`.

### 3.5 Verify
- Site loads, map renders, wind animates. DevTools -> Network: wind PNGs come from `data.DOMAIN` with
  `cf-cache-status: HIT` on the second load.
- `curl -sI https://DOMAIN | grep -i 'strict-transport\|x-frame\|content-security'`.

---------------------------------------------------------------------------------------

## 4. GitHub secrets and variables **[OWNER]**

Settings -> Secrets and variables -> Actions. Create GitHub **Environments** `production` and
`preview` (Settings -> Environments); optionally require a reviewer on `production`.

| Name | Type | Where to get it | Used by |
|---|---|---|---|
| `R2_ACCOUNT_ID` | secret | Cloudflare dashboard -> R2 overview | `ingest.yml` |
| `R2_ACCESS_KEY_ID` | secret | R2 -> Manage API tokens (step 2.4) | `ingest.yml` |
| `R2_SECRET_ACCESS_KEY` | secret | same, shown once | `ingest.yml` |
| `R2_BUCKET` | secret | bucket name, e.g. `stormtrack-data` | `ingest.yml` |
| `FIRMS_MAP_KEY` | secret (optional) | https://firms.modaps.eosdis.nasa.gov/api/map_key/ | `ingest.yml` (hazards); without it the fires layer is skipped |
| `CLOUDFLARE_API_TOKEN` | secret | Cloudflare profile -> API tokens (3.2) | `deploy-web.yml` |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Cloudflare dashboard sidebar | `deploy-web.yml` |
| `PUBLIC_SUPABASE_URL` | **variable** | Supabase -> Settings -> API | `deploy-web.yml`, `ci.yml` |
| `PUBLIC_SUPABASE_ANON_KEY` | **variable** | Supabase -> Settings -> API (anon/publishable) | `deploy-web.yml`, `ci.yml` |
| `PUBLIC_DATA_BASE` | variable | `https://data.DOMAIN` | `deploy-web.yml`, `ci.yml` |
| `PUBLIC_API_BASE` | variable (optional) | Render service URL | `deploy-web.yml` |
| `PUBLIC_SITE_URL` | variable | `https://DOMAIN` | `deploy-web.yml` |
| `PUBLIC_CONTACT_EMAIL` | variable (optional) | where privacy requests go; shown on `/privacy` and `/terms`. Empty means the pages point to the GitHub issue tracker | `deploy-web.yml` |
| `CF_PAGES_PROJECT` | variable (optional) | default `stormtrack-web` | `deploy-web.yml` |
| `INGEST_ENABLED` | variable (optional) | set to `false` to pause all scheduled ingest | `ingest.yml` |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | not needed in GitHub (migrations are applied from your laptop; see rollback) | | |

`PUBLIC_*` values are intentionally **variables, not secrets**: they are baked into the public
bundle anyway.

**Cloudflare Pages builds do not see GitHub variables.** If the site is built by Pages itself (git
integration) and not by `deploy-web.yml`, set every `PUBLIC_*` value in the Pages project too
(Settings -> Variables and Secrets), then redeploy: a variable only takes effect on a new build.
Without `PUBLIC_DATA_BASE` the site falls back to its built-in sample data.

### Sign-in screens (Google and GitHub)

The consent screens show the address sign-in returns to, which is the Supabase project address.
That cannot be hidden without a Supabase custom domain (a paid add-on; check current pricing).
What you can set:

- **Supabase -> Authentication -> URL Configuration:** Site URL `https://DOMAIN`; Redirect URLs
  for `https://DOMAIN/**` (and the exact `https://DOMAIN/`), the `pages.dev` address, and
  `http://localhost:5173/**`. A wrong Site URL sends people to the wrong site after sign-in.
- **Google Cloud -> Google Auth Platform -> Branding:** app name StormTrack, logo
  `docs/brand/stormtrack-mark-120.png`, home page `https://DOMAIN`, privacy policy
  `https://DOMAIN/privacy`, terms `https://DOMAIN/terms`, authorized domain of the site.
- **GitHub -> OAuth app settings:** homepage `https://DOMAIN`, logo
  `docs/brand/stormtrack-mark-512.png`.

---------------------------------------------------------------------------------------

## 5. First data run

Actions -> "Ingest (scheduled)" -> Run workflow -> `only: wind`, then `storms`, then `hazards`.
Each job uploads payload files first and the pointer file last. Verify with the `curl` commands
in section 2 plus:
```bash
curl -s https://data.DOMAIN/storms/index.json
curl -s https://data.DOMAIN/hazards/index.json
```
Scheduled runs only start from the **default branch** and only after the workflow file is on `main`.
GitHub disables scheduled workflows after 60 days without repository activity (public repos):
re-enable in the Actions tab if that ever happens.

Schedules (UTC, see rationale in `ingest.yml`): wind `:35` every 3 h from 01:35; storms
`:07,:37`; hazards `:13,:33,:53`. Run-overlap is prevented per job by `concurrency`; a failed run
uploads nothing, so the previous data stays live (stale-while-revalidate / stale-if-error mask
short outages).

---------------------------------------------------------------------------------------

## 6. Render API (optional, when `services/api` is ready) **[OWNER]**

1. https://render.com -> New -> Blueprint -> connect the GitHub repo -> Blueprint path
   `infra/render/render.yaml` -> Apply.
2. Fill the env vars marked `sync: false` (see `.env.example`): `CORS_ORIGINS=https://DOMAIN`,
   `SUPABASE_URL`, `SUPABASE_JWT_SECRET`, `DATA_BASE_URL=https://data.DOMAIN`.
3. Verify: `curl https://<service>.onrender.com/healthz` returns 200. Then set the GitHub variable
   `PUBLIC_API_BASE` and redeploy the web app. Free instances sleep after 15 minutes idle.

---------------------------------------------------------------------------------------

## 7. Rollback

| What | How |
|---|---|
| Web | Cloudflare dashboard -> Pages -> Deployments -> previous deployment -> "Rollback to this deployment". Or revert the commit on `main` and let CI redeploy. |
| Data (bad run published) | Re-run the ingest workflow (it publishes a fresh pointer), or `npx wrangler r2 object put stormtrack-data/wind/latest.json --file <previous latest.json> --content-type application/json --cache-control "public, max-age=60"` to repoint at an older run (frames are immutable and kept). |
| Pause ingest | Set variable `INGEST_ENABLED=false` (or disable the workflow in the Actions tab). |
| Database | Migrations are forward-only. To undo, write a new migration (`supabase migration new revert_x`) and `supabase db push`. Before any destructive migration take a backup: Dashboard -> Database -> Backups (free tier: daily, 7 days) or `supabase db dump -f backup.sql`. |
| Secrets leaked | Rotate in the provider (R2 token, Cloudflare token, Supabase keys/JWT secret), then update the GitHub secret. A leaked **anon** key is not an incident (it is public); a leaked `service_role` or JWT secret is. |

---------------------------------------------------------------------------------------

## 8. Free-tier limits to watch

| Service | Limit (verify on the pricing page; these change) | Watch for |
|---|---|---|
| GitHub Actions | Public repo: free, unlimited minutes. Private: ~2000 min/month. Ingest ~ 48 storms + 72 hazards + 8 wind runs/day, 1-3 min each | If the repo is private, ingest alone may exceed the quota: make the repo public, or lower cron frequency in `ingest.yml` |
| Cloudflare Pages | 500 builds/month (we build in GitHub, so uploads only), 100 custom domains | none expected |
| Cloudflare R2 | 10 GB storage, 1 M Class-A (writes), 10 M Class-B (reads) per month; egress free | Each ingest writes tens of objects: ~130 runs/day x ~30 = ~120 k writes/month, fine. Old wind runs accumulate (~3 MB x 25 frames x 4 runs/day): add an R2 lifecycle rule (Bucket -> Settings -> Object lifecycle) deleting `wind/` objects older than 3 days |
| Supabase Free | 500 MB DB, 50 k MAU, 2 emails/h on built-in SMTP, project **pauses after 1 week of inactivity** | Configure custom SMTP; the app's traffic keeps it alive, but a quiet project will pause. Per-user caps in the schema bound DB growth (100 places, 50 views of <=16 kB, 200 follows per user) |
| Render Free | 750 h/month, sleeps after 15 min | cold starts; the app must degrade gracefully when the API is slow |
| NASA FIRMS | ~5000 transactions per 10 min per key | one call per hazards run is fine |

Set billing alerts: Cloudflare (Billing -> Notifications), Supabase (Org -> Billing -> spend cap
ON, which is the default on Free).

---------------------------------------------------------------------------------------

## 9. Owner-only checklist

- [ ] Create/push GitHub repo `atmospy/stormtrack-web`, enable Actions
- [ ] Create Supabase project, `supabase link`, `supabase db push`
- [ ] Supabase: Site URL, redirect URLs, Google provider, email templates, SMTP, rate limits
- [ ] Google Cloud OAuth client + consent screen
- [ ] Cloudflare: R2 bucket, CORS, API token, custom data domain, lifecycle rule, rate-limit rule
- [ ] Cloudflare: Pages project, API token, custom domain
- [ ] GitHub: all secrets and variables in section 4, environments
- [ ] (Optional) NASA FIRMS key; Render blueprint
- [ ] Choose the product name/domain; replace `stormtrack.example` in `infra/cloudflare/*`
