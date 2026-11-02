from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path


def default_out() -> str:
    if os.environ.get("PUBLIC_DATA_DIR"):
        return os.environ["PUBLIC_DATA_DIR"]
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / "public-data").is_dir() and (p / "docs").is_dir():
            return str(p / "public-data")
    return str(Path.cwd() / "public-data")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="ingest-wind", description=__doc__)
    ap.add_argument(
        "--out", default=None, help="data root (default $PUBLIC_DATA_DIR or <repo>/public-data)"
    )
    ap.add_argument("--run", help="force a run, YYYYMMDDHH (UTC)")
    ap.add_argument("--hours", type=int, default=72, help="last forecast hour (default 72)")
    ap.add_argument("--step", type=int, default=3, help="hours between frames (default 3)")
    ap.add_argument(
        "--res", type=float, default=0.5, help="output grid step in degrees (default 0.5)"
    )
    ap.add_argument(
        "--method",
        choices=["nearest", "mean"],
        default="nearest",
        help="nearest = every Nth point (default); mean = box average",
    )
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--keep", type=int, default=2, help="runs to keep per model (default 2)")
    ap.add_argument(
        "--models",
        default="gfs",
        help="comma list of gfs, ecmwf-ifs, ecmwf-aifs (default gfs)",
    )
    ap.add_argument(
        "--fields",
        default=None,
        help="comma list of wind, mslp, t2m, precip (default all) or exact slugs e.g. wind_850",
    )
    ap.add_argument(
        "--levels",
        default=None,
        help="wind levels, comma list of 10m,850,700,500,300,250 (default all)",
    )
    ap.add_argument(
        "--upper-step",
        type=int,
        default=None,
        help="publish pressure-level winds only every N hours (size reduction; default = --step)",
    )
    ap.add_argument("--dry-run", action="store_true", help="pick+verify the run, write nothing")
    ap.add_argument("--upload", action="store_true", help="upload to S3/R2 using R2_* env vars")
    ap.add_argument(
        "--selftest", action="store_true", help="offline end-to-end check on a synthetic fixture"
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    if a.selftest:
        from .selftest import run_selftest

        return run_selftest()

    from . import fields, gfs, models, weather

    out = a.out or default_out()
    run = gfs.parse_run(a.run) if a.run else None
    try:
        model_list = models.get_models(a.models)
        specs = fields.select(a.fields, a.levels)
    except ValueError as e:
        ap.error(str(e))
    res = weather.ingest_all(
        out,
        model_list,
        specs,
        runs={m.id: run for m in model_list} if run else None,
        dry_run=a.dry_run,
        keep=a.keep,
        hours=a.hours,
        step=a.step,
        upper_step=a.upper_step,
        res=a.res,
        method=a.method,
        workers=a.workers,
    )
    print(weather.report(res))
    if a.upload and res["models"]:
        from . import upload

        upload.upload_all(
            upload.client_from_env(),
            os.environ["R2_BUCKET"],
            out,
            res,
            os.environ.get("R2_PREFIX", ""),
            a.keep,
        )
    return 1 if res["errors"] else 0
