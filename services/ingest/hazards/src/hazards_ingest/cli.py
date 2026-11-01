"""``ingest-hazards`` command line.

Each source is independent: a failure is logged and recorded in ``index.json`` under
``failed`` and the previously published file for that layer (if any) is left in place.
Exit status is non-zero only when every attempted source failed.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

from . import sources
from .common import gz_size, now_iso, write_json
from .validate import validate_collection, validate_index

log = logging.getLogger("ingest-hazards")
DEFAULT_OUT = "/Users/syed44/Git_Stuff/Git_Projects/stormtrack-web/public-data"


def main(argv=None, env=os.environ, fetchers=None) -> int:
    ap = argparse.ArgumentParser(prog="ingest-hazards", description=__doc__)
    ap.add_argument(
        "--out", default=env.get("HAZARDS_OUT", DEFAULT_OUT), help="public-data directory"
    )
    ap.add_argument(
        "--eonet-days", type=int, default=30, help="EONET: events with activity in the last N days"
    )
    ap.add_argument("--firms-days", type=int, default=1)
    ap.add_argument("--upload", action="store_true", help="upload to R2 (needs R2_* env vars)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    out = Path(args.out)
    hz = out / "hazards"

    f = {
        "events": lambda: sources.fetch_eonet(args.eonet_days),
        "quakes": sources.fetch_usgs,
    }
    meta = {
        "events": ("NASA EONET", "https://eonet.gsfc.nasa.gov/"),
        "quakes": ("USGS", "https://earthquake.usgs.gov/earthquakes/feed/"),
        "fires": ("NASA FIRMS", "https://firms.modaps.eosdis.nasa.gov/"),
    }
    key = env.get("FIRMS_MAP_KEY")
    if key:
        f["fires"] = lambda: sources.fetch_firms(key, args.firms_days)
    else:
        log.info("FIRMS_MAP_KEY not set: skipping fires.geojson")
    if fetchers:
        f = fetchers

    prev = {}
    try:
        prev = json.loads((hz / "index.json").read_text()).get("layers", {})
    except Exception:  # noqa: BLE001
        pass
    layers, failed, written = {}, {}, []
    for name, fn in f.items():
        t0 = time.time()
        try:
            fc = fn()
            errs = validate_collection(fc, name)
            if errs:
                raise RuntimeError(f"validation: {errs[:3]}")
            p = hz / f"{name}.geojson"
            size = write_json(p, fc)
            written.append(f"hazards/{name}.geojson")
            layers[name] = {
                "count": len(fc["features"]),
                "source": meta[name][0],
                "url": meta[name][1],
                "licence": fc.get("licence"),
                "updated": now_iso(),
            }
            log.info(
                "%s: %d features, %.0f kB (%.0f kB gzip) in %.1fs",
                name,
                len(fc["features"]),
                size / 1e3,
                gz_size(p) / 1e3,
                time.time() - t0,
            )
        except Exception as exc:  # noqa: BLE001
            failed[name] = f"{type(exc).__name__}: {exc}"[:300]
            log.error("%s failed: %s", name, failed[name])
            if name in prev:  # keep serving the last good file and its metadata
                layers[name] = {**prev[name], "stale": True}
    if not written:
        log.error("every source failed; index.json not touched")
        return 1
    # layers whose file exists but were not attempted this run (e.g. fires without a key) keep their old entry
    for name, entry in prev.items():
        if name not in layers and (hz / f"{name}.geojson").exists() and name not in f:
            layers[name] = {**entry, "stale": True}
    index = {"schema": 1, "generated": now_iso(), "layers": layers}
    if failed:
        index["failed"] = failed
    errs = validate_index(index)
    if errs:
        log.error("index invalid: %s", errs)
        return 1
    write_json(hz / "index.json", index)  # LAST
    written.append("hazards/index.json")
    if args.upload:
        from .upload import upload_files

        log.info("uploaded %d objects", len(upload_files(out, written, env=env)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
