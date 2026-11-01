"""``ingest-storms`` command line."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

from . import __version__
from .common import gz_size, now_iso, write_json

log = logging.getLogger("ingest-storms")

DEFAULT_OUT = "/Users/syed44/Git_Stuff/Git_Projects/stormtrack-web/public-data"
DEFAULT_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "stormtrack-web"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(prog="ingest-storms", description=__doc__)
    ap.add_argument(
        "--out", default=os.environ.get("STORMS_OUT", DEFAULT_OUT), help="public-data directory"
    )
    ap.add_argument(
        "--basin",
        default="NI",
        help="IBTrACS basin code for history/stats (default NI; "
        "others download a large NCEI file, see README)",
    )
    ap.add_argument(
        "--only",
        choices=["all", "active", "history"],
        default="all",
        help="run just the live part (cron, every 30 min) or just history+stats (rarely)",
    )
    ap.add_argument(
        "--cache-dir", default=str(DEFAULT_CACHE), help="cache for cone-radius error samples"
    )
    ap.add_argument(
        "--cone-years", type=int, default=2, help="completed seasons used for cone radii"
    )
    ap.add_argument("--no-cone", action="store_true", help="skip the (cached) cone-radius estimate")
    ap.add_argument(
        "--upload", action="store_true", help="upload written files to R2 (needs R2_* env vars)"
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap.parse_args(argv)


def _read_json(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return None


def run_history(out: Path, basin: str, written: list) -> dict:
    import stormtrack as st

    from .history import build_history
    from .stats import build_stats
    from .validate import validate_history, validate_stats

    t0 = time.time()
    if basin == "NI":
        bt = st.load_ibtracs()
        sources = ["IMD", "IBTrACS"]
    else:  # large download from NCEI; documented extension
        bt = st.load_ibtracs(basin=basin, source="ncei")
        sources = ["IBTrACS"]
    obs, storms = bt.observations, bt.storms
    coll, skipped = build_history(obs, storms)
    errs = validate_history(coll)
    if errs:
        raise RuntimeError(f"history failed validation: {errs[:5]}")
    hp = out / "storms" / "history" / f"{basin}.geojson"
    size = write_json(hp, coll)
    written.append(hp.relative_to(out).as_posix())
    log.info(
        "history %s: %d storms (%d skipped <2 fixes), %.2f MB raw, %.0f kB gzip",
        basin,
        len(coll["features"]),
        len(skipped),
        size / 1e6,
        gz_size(hp) / 1e3,
    )

    stats = build_stats(obs, basin)
    errs = validate_stats(stats)
    if errs:
        raise RuntimeError(f"stats failed validation: {errs[:5]}")
    sp = out / "storms" / "stats" / f"{basin}.json"
    write_json(sp, stats)
    written.append(sp.relative_to(out).as_posix())
    log.info("stats %s written (%.1fs total)", basin, time.time() - t0)
    return {
        "count": len(coll["features"]),
        "year_min": int(obs["year"].min()),
        "year_max": int(obs["year"].max()),
        "sources": sources,
    }


def run_active(out: Path, args, written: list):
    from .active import build_active
    from .cone import build_radii
    from .validate import validate_active

    radii = None
    if not args.no_cone:
        t0 = time.time()
        try:
            radii = build_radii(Path(args.cache_dir), args.cone_years)
            log.info("cone radii (%.0fs): %s", time.time() - t0, radii["basis"])
        except Exception as exc:  # noqa: BLE001
            log.warning("cone radii unavailable, cones omitted: %s", exc)
    coll, report = build_active(radii)
    if not report["ok"]:
        raise RuntimeError(f"all active sources failed: {report['failed']}")
    errs = validate_active(coll)
    if errs:
        raise RuntimeError(f"active failed validation: {errs[:5]}")
    ap = out / "storms" / "active.geojson"
    write_json(ap, coll)
    written.append(ap.relative_to(out).as_posix())
    log.info(
        "active: %d storms %s; forecasts ok %s, unavailable %s; failed sources %s",
        len(report["storms"]),
        [(s["id"], s["name"]) for s in report["storms"]],
        report["forecast_ok"],
        report["forecast_unavailable"],
        report["failed"],
    )
    return report


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    out = Path(args.out)
    basin = args.basin.upper()
    prev = _read_json(out / "storms" / "index.json") or {}
    written: list = []
    failures = 0
    attempted = 0
    active_block, history_block = prev.get("active"), dict(prev.get("history") or {})
    t_start = time.time()

    if args.only in ("all", "active"):
        attempted += 1
        try:
            rep = run_active(out, args, written)
            active_block = {
                "count": len(rep["storms"]),
                "updated": now_iso(),
                "sources": [{"nhc": "NHC", "jtwc": "JTWC"}[s] for s in rep["ok"]],
                "failed_sources": sorted(rep["failed"]),
                "forecast_unavailable": rep["forecast_unavailable"],
                "storms": rep["storms"],
            }
        except Exception as exc:  # noqa: BLE001
            failures += 1
            log.error("active job failed: %s", exc)
    if args.only in ("all", "history"):
        attempted += 1
        try:
            history_block[basin] = run_history(out, basin, written)
        except Exception as exc:  # noqa: BLE001
            failures += 1
            log.error("history/stats job failed: %s", exc, exc_info=args.verbose)

    if failures == attempted:
        log.error("nothing succeeded; index.json not touched")
        return 1

    from .validate import validate_index

    index = {
        "schema": 1,
        "generated": now_iso(),
        "active": active_block or {"count": 0, "updated": now_iso(), "sources": []},
        "history": history_block,
        "generator": f"ingest-storms {__version__}",
    }
    errs = validate_index(index)
    if errs:
        log.error("index invalid: %s", errs)
        return 1
    write_json(out / "storms" / "index.json", index)  # LAST, atomic
    written.append("storms/index.json")

    if args.upload:
        from .upload import upload_files

        keys = upload_files(out, written)
        log.info("uploaded %d objects to R2: %s", len(keys), keys)
    log.info(
        "done in %.0fs; %d failure(s) of %d component(s)",
        time.time() - t_start,
        failures,
        attempted,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
