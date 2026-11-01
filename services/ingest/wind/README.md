# stormtrack-ingest-wind

GFS 0.25° 10 m wind -> equirectangular PNG textures + `wind/latest.json`, exactly per
`docs/CONTRACTS.md` section 1.

## Quick start

```bash
cd services/ingest/wind
uv sync                       # python >=3.9; installs numpy, pillow, eccodes (bundled libeccodes wheel)
uv run ingest-wind            # latest complete run -> $PUBLIC_DATA_DIR or <repo>/public-data
uv run ingest-wind --out ./out --hours 72 --step 3 --res 0.5
uv run ingest-wind --run 2026110106 --dry-run     # check a run, write nothing
uv run ingest-wind --selftest                     # offline end-to-end on a synthetic GRIB2
uv run verify-wind --fhr 0 24 72                  # re-download source, compare PNG (needs network)
uv run pytest                                     # offline tests
uv run pytest -m network                          # one real-bucket integration test
```
Also `python -m stormtrack_ingest_wind ...`.

Options: `--out` (env `PUBLIC_DATA_DIR`), `--run YYYYMMDDHH`, `--hours` (72), `--step` (3),
`--res` (0.5; must be a multiple of 0.25), `--method nearest|mean` (every Nth point, default, or
box average), `--workers` (4), `--keep` (2), `--dry-run`, `--upload`, `--selftest`, `-v`.

## What it does
1. Probes runs from "now" backwards (00/06/12/18Z). A run is accepted only if the `.idx` of
   **every** needed forecast hour exists (NOAA writes the `.idx` after the GRIB). Otherwise it
   falls back to the previous cycle (up to 8 cycles back).
2. For each hour: GET the small `.idx`, then one HTTP **byte-range** request covering the
   adjacent `UGRD:10 m above ground` + `VGRD:10 m above ground` records (~1.9 MB; the full file is hundreds of MB).
3. Decodes with eccodes, rolls longitude 0..360 -> -180..180, north-first, takes every 2nd point -> 720x361.
4. Writes `wind/<run>/fFFF.png` atomically (skips frames already present), then writes
   `wind/latest.json` atomically **last**, then prunes all but the newest 2 runs.

## Decoder choice
GFS 10 m wind is GRIB2 **template 5.3** (complex packing + spatial differencing), not JPEG2000.
`eccodes` (PyPI, >=2.42) ships a self-contained libeccodes binary wheel for macOS arm64 and
Linux x86_64, so there is no system install, no `cfgrib`/`xarray`, no conda. (It prints a harmless
"ecCodes 2.42.0 or higher is recommended" warning, filtered in code.)

## CI (workstream E)
GitHub Actions, cron every 3-6 h (a cycle lands ~4-5 h after its nominal time; `0 */3 * * *` is fine:
the job is idempotent and picks the newest complete run):

```yaml
- uses: astral-sh/setup-uv@v5
- run: uv sync --extra upload
  working-directory: services/ingest/wind
- run: uv run ingest-wind --out ../../../public-data --upload
  working-directory: services/ingest/wind
  env:
    R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}
    R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
    R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    R2_BUCKET: ${{ secrets.R2_BUCKET }}
    # optional: R2_ENDPOINT_URL (overrides the account URL), R2_PREFIX (key prefix)
```
Runtime about 1 min, about 50 MB downloaded. Without `--upload` no credentials are needed.

`--upload` (boto3, S3 API against `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`) uploads PNGs first
(`Cache-Control: public, max-age=31536000, immutable`), `latest.json` last (`max-age=60`), then
deletes remote runs older than the newest `--keep`. Keys are `<R2_PREFIX>/wind/...`, matching
`PUBLIC_DATA_BASE + "/" + frame.png`. Tested against a fake S3 client (no credentials in code).

## Verification
`verify.py` decodes a PNG back to u/v (`encode.decode_png`, `verify.point(png, lat, lon)`) and checks
max |error| <= half the quantisation step (100/255/2 = 0.196 m/s) against the resampled source, plus
sanity: max speed < 70, area-weighted mean 3-9 m/s, mean u > 0 at 45N and < 0 at 10N.
