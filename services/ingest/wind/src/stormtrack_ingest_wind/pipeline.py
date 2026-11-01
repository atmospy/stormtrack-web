from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

from . import encode, gfs, grib, grid, http

log = logging.getLogger("stormtrack.wind")
RUN_RE = re.compile(r"^\d{8}T\d{2}$")
ISO = "%Y-%m-%dT%H:%M:%SZ"


def frame_hours(hours: int, step: int) -> List[int]:
    if step <= 0 or hours < 0:
        raise ValueError("bad --hours/--step")
    return list(range(0, hours + 1, step))


def _valid_png(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return os.path.getsize(path) > 100 and fh.read(8) == b"\x89PNG\r\n\x1a\n"
    except OSError:
        return False


def process_frame(run, fhr, out_dir, res, method) -> dict:
    rid = gfs.run_id(run)
    rel = f"wind/{rid}/f{fhr:03d}.png"
    path = os.path.join(out_dir, rel)
    if _valid_png(path):
        log.info("f%03d: present, skipped", fhr)
    else:
        t = time.time()
        raw = gfs.fetch_uv(run, fhr)
        field = grib.decode_uv(raw)
        u, v, g = grid.resample(field, res, method)
        data = encode.png_bytes(u, v)
        encode.atomic_write(path, data)
        log.info("f%03d: GRIB %d B -> PNG %d B (%dx%d) in %.1fs", fhr, len(raw), len(data),
                 g.width, g.height, time.time() - t)
    return {"fhr": fhr, "valid": (run + dt.timedelta(hours=fhr)).strftime(ISO),
            "png": rel, "bytes": os.path.getsize(path)}


def prune(out_dir: str, keep: int = 2) -> List[str]:
    root = os.path.join(out_dir, "wind")
    runs = sorted(d for d in os.listdir(root) if RUN_RE.match(d) and os.path.isdir(os.path.join(root, d)))
    gone = runs[:-keep] if keep > 0 else []
    for d in gone:
        shutil.rmtree(os.path.join(root, d))
        log.info("pruned old run %s", d)
    return gone


def ingest(out_dir, *, run=None, hours=72, step=3, res=0.5, method="nearest", workers=4,
           now=None, dry_run=False, keep=2) -> Optional[dict]:
    t0 = time.time()
    fhrs = frame_hours(hours, step)
    now = now or dt.datetime.now(dt.timezone.utc)
    if run is None:
        run = gfs.find_latest_run(now, fhrs)
    elif not gfs.run_complete(run, fhrs):
        raise RuntimeError(f"run {gfs.run_id(run)} is not complete on the bucket")
    rid = gfs.run_id(run)
    log.info("using run %s, %d frames (f%03d..f%03d every %dh), grid res %.3f deg",
             rid, len(fhrs), fhrs[0], fhrs[-1], step, res)
    if dry_run:
        log.info("dry-run: would write %s/wind/%s/ and latest.json", out_dir, rid)
        return None
    os.makedirs(os.path.join(out_dir, "wind"), exist_ok=True)
    with ThreadPoolExecutor(workers) as ex:
        frames = list(ex.map(lambda f: process_frame(run, f, out_dir, res, method), fhrs))

    # grid description from the first frame on disk
    from PIL import Image
    with Image.open(os.path.join(out_dir, frames[0]["png"])) as im:
        w, h = im.size
    latest = {
        "schema": 1,
        "source": "NOAA GFS 0.25°",
        "licence": "US Government work, public domain",
        "level": "10m",
        "units": "m/s",
        "run": run.strftime(ISO),
        "generated": dt.datetime.now(dt.timezone.utc).strftime(ISO),
        "image": {"width": w, "height": h, "lon_left": -180,
                  "lon_right": -180 + (w - 1) * res, "lat_top": 90, "lat_bottom": -90,
                  "u": {"min": -50, "max": 50}, "v": {"min": -50, "max": 50},
                  "speed_max": 70},
        "frames": frames,
    }
    # pointer LAST, atomically
    encode.atomic_write(os.path.join(out_dir, "wind", "latest.json"),
                        (json.dumps(latest, indent=2, ensure_ascii=False) + "\n").encode())
    prune(out_dir, keep)
    log.info("done: run %s, %d frames, %d B PNG total, %d B downloaded in %d requests, %.1fs",
             rid, len(frames), sum(f["bytes"] for f in frames), http.STATS["bytes"],
             http.STATS["requests"], time.time() - t0)
    return latest
