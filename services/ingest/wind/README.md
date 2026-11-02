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

## Weather fields v2 (CONTRACTS 1b)

`ingest-wind` now publishes several models x fields x levels. Defaults: `--models gfs`, every field,
every level, f000-f072 every 3 h, 0.5 deg (720x361).

```bash
uv run ingest-wind --models gfs,ecmwf-ifs,ecmwf-aifs            # everything
uv run ingest-wind --models gfs --fields wind,mslp --levels 10m,850,250
uv run ingest-wind --models ecmwf-ifs --fields precip --hours 24 --dry-run
uv run ingest-wind --upper-step 6                               # pressure-level winds every 6 h (size cut)
uv run verify-weather --models gfs --fhr 0 24 72 --source     # decode PNGs, plausibility, round trip vs source GRIB
```
Flags added: `--models`, `--fields` (`wind,mslp,t2m,precip` or slugs such as `wind_850`), `--levels`
(`10m,850,700,500,300,250`), `--upper-step`. Exit status is 1 when any model failed (the others are still
published; a failing model never blocks the rest).

Output tree (pointers written after the frames they list, `weather/index.json` last):
```
weather/index.json
weather/<model>/latest.json
weather/<model>/<run>/<slug>/fFFF.png      slugs: wind_10m wind_850 wind_700 wind_500 wind_300 wind_250 mslp t2m precip
wind/latest.json, wind/<run>/fFFF.png      legacy v1 (GFS 10 m wind, byte-identical to weather/gfs/<run>/wind_10m)
```

### Sources and layout (verified against the live buckets)
| model | where | per-frame files | steps |
|---|---|---|---|
| GFS | `s3://noaa-gfs-bdp-pds/gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p25.fFFF` + `.idx` | one GRIB per hour, byte ranges from the `.idx` | hourly to 120 h, 3-hourly to 384 h; 4 cycles |
| IFS | `ecmwf-forecasts.s3.eu-central-1.amazonaws.com/YYYYMMDD/HHz/ifs/0p25/oper/YYYYMMDDHH0000-<step>h-oper-fc.grib2` + `.index` | JSON-lines index with `_offset/_length` | 00/12Z: 3-hourly to 144 h then 6-hourly to 360 h; 06/18Z: 3-hourly to 144 h |
| AIFS | same bucket, `.../aifs-single/0p25/oper/...` | same | 6-hourly to 360 h, all four cycles |

GRIB records used: GFS `UGRD/VGRD:10 m above ground`, `UGRD/VGRD:<p> mb`, `PRMSL:mean sea level`
(Pa; `MSLET` is a different reduction and is not used), `TMP:2 m above ground`, `APCP:surface`.
ECMWF `10u 10v` (sfc), `u v` (pl 850..250), `msl`, `2t`, `tp`. ECMWF data is CCSDS-packed and starts at
180E: decoding and the roll to -180..180 are handled; units are read from the GRIB and converted
(Pa->hPa, K->degC, m->mm), anything unexpected raises instead of being guessed.
AIFS only has 6-hourly steps, so with `--step 3` its frames are f000, f006, ...; consumers read `fhr`.
Fields a model does not provide (probed in the index of the last frame) are omitted from its `latest.json`.

### Precipitation
Frame `f` holds the depth (mm) over the interval ending at its valid time; frame 0 is zeros.
GFS writes two `APCP` records per file: a bucket that resets every 6 h (`0-3, 0-6, 6-9, 6-12 ...`) and
the running total since the run start. We use only the **last** record (the running total; asserted
`startStep == 0`) and difference consecutive frames: `precip(f) = max(total(f) - total(prev frame), 0)`.
IFS/AIFS `tp` is likewise cumulative from the run start. Each frame carries an extra `interval_h`
(3 for GFS/IFS, 6 for AIFS) since "per frame interval" differs by model.

### Encodings
Vectors: 8-bit R=u G=v B=speed with each field's own `range` (10 m +-50/70 as in v1; 850 +-60/85; 700 +-70/100;
500 +-80/115; 300 and 250 +-100/140; jet cores above 100 m/s saturate in u/v). Scalars: 16-bit,
R=high byte, G=low byte, B=0, A=255, over mslp 930-1070 hPa (step 0.0021 hPa), t2m -60..60 degC
(0.0018), precip 0-100 mm with `transform: "sqrt"`: `v16 = round((sqrt(x)-sqrt(min))/(sqrt(max)-sqrt(min))*65535)`,
`range` stays in physical units. Every frame is decoded back and compared before it is written
(error must be below one quantisation step; in practice half a step).

### Heavy runs
Per model run (25 frames x 9 fields, 0.5 deg): about 70 MB of PNG and about 250-300 MB downloaded (10 m + five
levels dominate). `--upper-step 6` halves the pressure-level share; see the report in the repo history for measured numbers.

### Upload
`--upload` uploads each model's frames (`Cache-Control: public, max-age=31536000, immutable`, skipped when the
object already exists with the same size), then that model's `latest.json`, then the legacy `wind/` tree, then
`weather/index.json` last (merged with the remote catalogue so a one-model run never drops the others);
pointers use `max-age=60`. Remote runs beyond `--keep` per model are deleted.

## What it does (GFS 10 m wind, unchanged v1 behaviour)
1. Probes runs from "now" backwards (00/06/12/18Z); a run is accepted only if the `.idx` of **every**
   needed hour exists, else it falls back (up to 8 cycles).
2. Per hour: GET the `.idx`, then byte-range requests for just the wanted records (adjacent ones merged).
3. Decodes with eccodes, rolls longitude to -180..180, north-first, every 2nd point -> 720x361.
4. Writes frames atomically (skipping valid ones), pointers last, prunes all but the newest 2 runs per model.

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
Default (GFS, all fields) is roughly 300 MB / 3-5 min; ECMWF models add ~similar each. Without `--upload` no credentials are needed.

`--upload` (boto3, S3 API against `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`) uploads PNGs first
(`Cache-Control: public, max-age=31536000, immutable`), `latest.json` last (`max-age=60`), then
deletes remote runs older than the newest `--keep`. Keys are `<R2_PREFIX>/wind/...`, matching
`PUBLIC_DATA_BASE + "/" + frame.png`. Tested against a fake S3 client (no credentials in code).

## Verification
`verify.py` decodes a PNG back to u/v (`encode.decode_png`, `verify.point(png, lat, lon)`) and checks
max |error| <= half the quantisation step (100/255/2 = 0.196 m/s) against the resampled source, plus
sanity: max speed < 70, area-weighted mean 3-9 m/s, mean u > 0 at 45N and < 0 at 10N.
