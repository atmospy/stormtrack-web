# StormTrack API (skeleton)

Small FastAPI app wrapping the `stormtrack` library. Not on the critical path: the homepage uses the static
files from the ingest jobs.

| route | what |
|---|---|
| `GET /healthz` | liveness |
| `GET /v1/storms/active` | GeoJSON points for active NHC/JTWC systems (no forecasts; those are in the static `active.geojson`); cached 5 min in memory; a failing agency is listed under `failed` |
| `GET /v1/storms/{id}/summary` | lifetime summary computed with `stormtrack.analysis` (peak, category, genesis, duration, ACE, rapid intensification). Looks in IBTrACS NI first, then in active storms. Cached 1 h. |

Env: `CORS_ORIGINS` (comma-separated allowed origins; no CORS headers when unset), `ACTIVE_TTL_SECONDS` (300),
`SUMMARY_TTL_SECONDS` (3600), `PORT` (8080 in Docker), `STORMTRACK_DATA_DIR` (optional local dataset dir).

```bash
cd services/api && uv sync && uv run pytest
uv run uvicorn stormtrack_api.app:app --reload
docker build -t stormtrack-api \
  --build-arg STORMTRACK_SPEC="stormtrack[xarray] @ git+https://github.com/atmospy/stormtrack.git" .
```
The Dockerfile binds `$PORT` (Render/Fly compatible), runs as a non-root user and defines a health check on `/healthz`.
First request for a historical summary loads IBTrACS (downloaded from GitHub at first use); the Docker build was
not run in this workspace.
