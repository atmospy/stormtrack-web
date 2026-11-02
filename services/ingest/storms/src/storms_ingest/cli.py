"""``ingest-storms`` command line."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

from . import __version__, basins
from .common import gz_size, now_iso, write_json

log = logging.getLogger("ingest-storms")

DEFAULT_OUT = "public-data"  # relative to the working directory; CI passes --out explicitly
DEFAULT_CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "stormtrack-web"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(prog="ingest-storms", description=__doc__)
    ap.add_argument(
        "--out", default=os.environ.get("STORMS_OUT", DEFAULT_OUT), help="public-data directory"
    )
    ap.add_argument(
        "--basin",
        default="NI",
        help="history/stats basins: ALL, or comma-separated IBTrACS codes "
        "(NA,EP,WP,NI,SI,SP,SA). Default NI. Non-NI basins download that basin's NCEI CSV "
        "(25-110 MB each) into <ibtracs-cache-dir>; see README.",
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
        "--ibtracs-cache-dir",
        default=None,
        help="cache for downloaded IBTrACS per-basin CSVs (default <cache-dir>/ibtracs); "
        "persist it between CI runs with actions/cache",
    )
    ap.add_argument(
        "--cone-years", type=int, default=2, help="completed seasons used for cone radii"
    )
    ap.add_argument("--no-cone", action="store_true", help="skip the (cached) cone-radius estimate")
    ap.add_argument(
        "--upload", action="store_true", help="upload written files to R2 (needs R2_* env vars)"
    )
    ap.add_argument(
        "--prev-url",
        default=os.environ.get("PUBLIC_DATA_BASE") or None,
        help="public data base URL; when the output dir has no previous storms/index.json (a "
        "stateless CI runner) it is fetched from <prev-url>/storms/index.json so a partial run "
        "(--only active / history) merges into the published index instead of erasing the rest",
    )
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap.parse_args(argv)


def _read_json(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:  # noqa: BLE001
        return None


def _read_prev_index(out: Path, base_url) -> dict:
    """Previous ``storms/index.json``: from the output dir, else from the published URL, else {}."""
    local = _read_json(out / "storms" / "index.json")
    if local:
        return local
    if not base_url:
        return {}
    import urllib.request

    try:
        url = base_url.rstrip("/") + "/storms/index.json"
        # Cloudflare answers 403 to Python's default user agent, which silently dropped the previous
        # index (and with it the active and history blocks), so identify ourselves
        req = urllib.request.Request(url, headers={"User-Agent": "stormtrack-web-ingest"})
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310
            data = json.loads(r.read())
        return data if isinstance(data, dict) else {}
    except Exception as exc:  # noqa: BLE001 - a missing/unreachable index just means a fresh start
        log.warning("could not read previous index from %s: %s", base_url, exc)
        return {}


def _entry(out: Path, basin: str, count: int, y0: int, y1: int, sources: list) -> dict:
    """Index block for one basin, sizes measured from the files on disk."""
    hp = out / "storms" / "history" / f"{basin}.geojson"
    return {
        "count": count,
        "year_min": y0,
        "year_max": y1,
        "sources": sources,
        "name": basins.BASINS[basin],
        "file": f"storms/history/{basin}.geojson",
        "stats": f"storms/stats/{basin}.json",
        "bytes": hp.stat().st_size,
        "gzip_bytes": gz_size(hp),
    }


def run_history(out: Path, basin: str, written: list, cache_dir: Path = None) -> dict:
    from .history import build_history
    from .stats import build_stats
    from .validate import validate_history, validate_stats

    t0 = time.time()
    obs, storms, sources = basins.load_basin(basin, cache_dir)
    log.info(
        "%s: loaded %d storms / %d fixes (%.1fs)", basin, len(storms), len(obs), time.time() - t0
    )
    coll, skipped = build_history(obs, storms, basin)
    errs = validate_history(coll, basin)
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
    return _entry(
        out, basin, len(coll["features"]), int(obs["year"].min()), int(obs["year"].max()), sources
    )


def complete_history_block(out: Path, block: dict) -> dict:
    """Fill Round 2 fields of entries written by an older run (e.g. NI) from disk."""
    done = {}
    for b, h in block.items():
        if b not in basins.BASINS:
            continue
        if (out / "storms" / "history" / f"{b}.geojson").exists():
            h = {**_entry(out, b, h["count"], h["year_min"], h["year_max"], h["sources"]), **h}
            h.update(_entry(out, b, h["count"], h["year_min"], h["year_max"], h["sources"]))
        done[b] = h
    return {b: done[b] for b in basins.BASINS if b in done}


def write_all_index(out: Path, block: dict, written: list) -> dict:
    rows = [{"id": b, **{k: h[k] for k in _ALL_KEYS}} for b, h in block.items()]
    ai = {
        "schema": 1,
        "generated": now_iso(),
        "basins": rows,
        "total_bytes": sum(r["bytes"] for r in rows),
        "total_gzip_bytes": sum(r["gzip_bytes"] for r in rows),
    }
    from .validate import validate_all_index

    errs = validate_all_index(ai)
    if errs:
        raise RuntimeError(f"all-index invalid: {errs}")
    write_json(out / "storms" / "history" / "all-index.json", ai)
    written.append("storms/history/all-index.json")
    return ai


_ALL_KEYS = ("name", "count", "year_min", "year_max", "file", "stats", "bytes", "gzip_bytes")


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
    try:
        todo = basins.basin_list(args.basin)
    except ValueError as exc:
        log.error("%s", exc)
        return 2
    ib_cache = Path(args.ibtracs_cache_dir or Path(args.cache_dir) / "ibtracs")
    prev = _read_prev_index(out, args.prev_url)
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
        for basin in todo:
            attempted += 1
            try:
                history_block[basin] = run_history(out, basin, written, ib_cache)
            except Exception as exc:  # noqa: BLE001
                failures += 1
                log.error("history/stats %s failed: %s", basin, exc, exc_info=args.verbose)

    if failures == attempted:  # also covers a basin list that produced nothing
        log.error("nothing succeeded; index.json not touched")
        return 1

    from .validate import validate_index

    history_block = complete_history_block(out, history_block)
    if history_block and args.only in ("all", "history"):
        write_all_index(out, history_block, written)
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
