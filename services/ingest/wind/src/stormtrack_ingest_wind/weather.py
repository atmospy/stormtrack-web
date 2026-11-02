"""Weather fields v2 pipeline (docs/CONTRACTS.md 1b): models x fields x levels -> PNG trees + pointers.

Order of writes, so a consumer never sees a half-published run:
  1. frames   weather/<model>/<run>/<slug>/fFFF.png         (atomic, skipped when already valid)
  2. pointer  weather/<model>/latest.json                   (after that model's frames)
  3. legacy   wind/<run>/fFFF.png + wind/latest.json        (GFS 10 m wind, CONTRACTS 1; unchanged)
  4. catalogue weather/index.json                           (LAST)
Precipitation is derived from the models' *cumulative* totals: see `precip_interval`.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Sequence

import numpy as np

from . import encode, fields, gfs, grid, http, models
from .fields import FieldSpec
from .models import Model

log = logging.getLogger("stormtrack.wind")
RUN_RE = re.compile(r"^\d{8}T\d{2}$")
ISO = "%Y-%m-%dT%H:%M:%SZ"


def _valid_png(path: str) -> bool:
    try:
        with open(path, "rb") as fh:
            return os.path.getsize(path) > 100 and fh.read(8) == b"\x89PNG\r\n\x1a\n"
    except OSError:
        return False


def precip_interval(cum_now: np.ndarray, cum_prev: np.ndarray) -> np.ndarray:
    """Depth (mm) over the interval ending at this frame = cumulative(now) - cumulative(prev).

    Both models accumulate from the run start (GFS: the second APCP record; ECMWF: `tp`), so the
    difference is exact whatever the bucket resets in GFS's other APCP record. The cumulative at
    f000 is 0 by definition (callers pass zeros), so frame 0 is all zeros. Tiny negatives from
    lossy packing are clipped to 0.
    """
    return np.maximum(cum_now - cum_prev, 0.0).astype(np.float32)


def encode_frame(spec: FieldSpec, a: np.ndarray, b: Optional[np.ndarray]) -> bytes:
    """Encode + round-trip check (cheap): a frame that does not decode back within one
    quantisation step is never written."""
    if spec.kind == "vector":
        rng = spec.vrange
        png = encode.vector_png(a, b, rng)
        du, dv, _ = encode.decode_vector(png, rng)
        err = max(
            float(np.abs(du - np.clip(a, rng.lo, rng.hi)).max()),
            float(np.abs(dv - np.clip(b, rng.lo, rng.hi)).max()),
        )
        lim = rng.step / 2 + 1e-4
    else:
        lo, hi = spec.srange
        a = a.astype(np.float64)
        png = encode.scalar_png(a, lo, hi, spec.transform)
        back = encode.decode_scalar(png, lo, hi, spec.transform)
        if spec.transform == "sqrt":
            # step is uniform in sqrt space; compare there
            err = float(np.abs(np.sqrt(back) - np.sqrt(np.clip(a, lo, hi))).max())
        else:
            err = float(np.abs(back - np.clip(a, lo, hi)).max())
        lim = encode.scalar_step(lo, hi, spec.transform) * 0.501
    if err > lim:
        raise AssertionError(f"{spec.slug}: round-trip error {err} > {lim}")
    return png


def frame_hours(hours: int, step: int) -> List[int]:
    if step <= 0 or hours < 0:
        raise ValueError("bad --hours/--step")
    return list(range(0, hours + 1, step))


def prune(root: str, keep: int, protect: str) -> List[str]:
    """Delete run directories beyond the newest `keep` (never `protect`)."""
    if not os.path.isdir(root):
        return []
    runs = sorted(
        d for d in os.listdir(root) if RUN_RE.match(d) and os.path.isdir(os.path.join(root, d))
    )
    gone = [d for d in (runs[:-keep] if keep > 0 else []) if d != protect]
    for d in gone:
        shutil.rmtree(os.path.join(root, d))
        log.info("pruned old run %s under %s", d, root)
    return gone


class _Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.png = {}  # slug -> [n, bytes]

    def add(self, slug, nbytes):
        with self.lock:
            e = self.png.setdefault(slug, [0, 0])
            e[0] += 1
            e[1] += nbytes


def ingest_model(
    model: Model,
    out_dir: str,
    specs: Sequence[FieldSpec],
    *,
    run: Optional[dt.datetime] = None,
    hours: int = 72,
    step: int = 3,
    upper_step: Optional[int] = None,
    res: float = 0.5,
    method: str = "nearest",
    workers: int = 4,
    now: Optional[dt.datetime] = None,
    dry_run: bool = False,
    keep: int = 2,
) -> Optional[dict]:
    """Produce one model's run; returns its latest.json dict (None for a dry run)."""
    t0 = time.time()
    b0 = (http.STATS["bytes"], http.STATS["requests"])
    workers = min(workers, model.max_workers)
    now = now or dt.datetime.now(dt.timezone.utc)
    want_h = frame_hours(hours, step)
    if run is None:
        run = model.find_latest_run(now, hours, step)
    else:
        fh = model.valid_fhrs(run, want_h)
        if not fh or not model.run_complete(run, fh):
            raise RuntimeError(f"[{model.id}] run {gfs.run_id(run)} is not complete on the bucket")
    rid = gfs.run_id(run)
    fhrs = model.valid_fhrs(run, want_h)
    if fhrs != want_h:
        log.info(
            "[%s] publishes %d of the %d requested hours (cadence/range)",
            model.id,
            len(fhrs),
            len(want_h),
        )
    specs = model.available_specs(run, fhrs[-1], specs)
    if not specs:
        raise RuntimeError(f"[{model.id}] none of the selected fields are available")

    def hours_for(s: FieldSpec) -> List[int]:
        if upper_step and s.pressure:
            return [h for h in fhrs if h % upper_step == 0]
        return fhrs

    log.info(
        "[%s] run %s, %d fields, %d frame hours (f%03d..f%03d), grid %.3f deg",
        model.id,
        rid,
        len(specs),
        len(fhrs),
        fhrs[0],
        fhrs[-1],
        res,
    )
    if dry_run:
        log.info("[%s] dry-run: would write %s/weather/%s/%s/", model.id, out_dir, model.id, rid)
        return None

    def rel(s, h):
        return f"weather/{model.id}/{rid}/{s.slug}/{fields.frame_name(h)}"

    def path(s, h):
        return os.path.join(out_dir, rel(s, h))

    stats = _Stats()

    # -- precipitation: cumulative totals first (each small record fetched once) -----------------
    cum: Dict[int, np.ndarray] = {}
    pspec = next((s for s in specs if s.group == "precip"), None)
    if pspec is not None:
        ph = hours_for(pspec)
        todo = [h for h in ph if not _valid_png(path(pspec, h))]
        need = set()
        for i, h in enumerate(ph):
            if h in todo:
                need |= {h} | ({ph[i - 1]} if i else set())
        need = sorted(x for x in need if x > 0)  # f000 is zeros by definition

        def get_cum(h):
            n = model.fetch(run, h, [pspec])[pspec.slug]
            a, _ = grid.resample_array(n.u, n.d, n.lons, n.lats, res, method)
            return h, a

        with ThreadPoolExecutor(workers) as ex:
            cum.update(dict(ex.map(get_cum, need)))

    def frame(h: int):
        """Fetch + encode + write every missing field of one forecast hour."""
        miss = [s for s in specs if h in hours_for(s) and not _valid_png(path(s, h))]
        fetch_specs = [s for s in miss if s.group != "precip"]
        got = model.fetch(run, h, fetch_specs) if fetch_specs else {}
        for s in miss:
            t = time.time()
            if s.group == "precip":
                ph = hours_for(s)
                i = ph.index(h)
                prev = ph[i - 1] if i else None
                if h == 0:
                    a = np.zeros(out_shape(res), np.float32)
                else:
                    a = precip_interval(cum[h], cum[prev] if prev else np.zeros_like(cum[h]))
                b = None
            else:
                n = got[s.slug]
                if s.kind == "vector":
                    a, b, _ = grid.resample(_field(n), res, method)
                else:
                    a, _ = grid.resample_array(n.u, n.d, n.lons, n.lats, res, method)
                    b = None
            data = encode_frame(s, a, b)
            encode.atomic_write(path(s, h), data)
            stats.add(s.slug, len(data))
            log.debug(
                "[%s] f%03d %s: %d B in %.2fs", model.id, h, s.slug, len(data), time.time() - t
            )
        return h

    with ThreadPoolExecutor(workers) as ex:
        for h in ex.map(frame, fhrs):
            log.info("[%s] f%03d done", model.id, h)

    # grid description from any frame on disk (never assumed)
    from PIL import Image

    s0 = specs[0]
    with Image.open(path(s0, hours_for(s0)[0])) as im:
        w, hgt = im.size
    latest = {
        "schema": 2,
        "model": model.id,
        "run": run.strftime(ISO),
        "generated": dt.datetime.now(dt.timezone.utc).strftime(ISO),
        "grid": {
            "width": w,
            "height": hgt,
            "lon_left": -180,
            "lon_right": -180 + (w - 1) * (360.0 / w),
            "lat_top": 90,
            "lat_bottom": -90,
        },
        "fields": [],
    }
    for s in specs:
        d = s.descriptor()
        frames = []
        ph = hours_for(s)
        for i, h in enumerate(ph):
            fr = {
                "fhr": h,
                "valid": (run + dt.timedelta(hours=h)).strftime(ISO),
                "png": rel(s, h),
                "bytes": os.path.getsize(path(s, h)),
            }
            if s.group == "precip":
                fr["interval_h"] = (h - ph[i - 1]) if i else 0
            frames.append(fr)
        d["frames"] = frames
        latest["fields"].append(d)
    mdir = os.path.join(out_dir, "weather", model.id)
    # per-model pointer LAST (after this model's frames), atomically
    encode.atomic_write(os.path.join(mdir, "latest.json"), _dump(latest))
    prune(mdir, keep, rid)
    total = sum(f["bytes"] for d in latest["fields"] for f in d["frames"])
    latest["_stats"] = {  # in-memory only (report); never written to disk
        "wall_s": time.time() - t0,
        "download_bytes": http.STATS["bytes"] - b0[0],
        "requests": http.STATS["requests"] - b0[1],
        "png_bytes": total,
        "per_field": {
            d["slug"]: {
                "frames": len(d["frames"]),
                "bytes": sum(f["bytes"] for f in d["frames"]),
                "avg": sum(f["bytes"] for f in d["frames"]) // max(1, len(d["frames"])),
            }
            for d in latest["fields"]
        },
    }
    log.info(
        "[%s] done: run %s, %d fields, %.1f MB PNG, %.1f MB downloaded in %d requests, %.1fs",
        model.id,
        rid,
        len(specs),
        total / 1e6,
        latest["_stats"]["download_bytes"] / 1e6,
        latest["_stats"]["requests"],
        latest["_stats"]["wall_s"],
    )
    return latest


def out_shape(res: float):
    """(rows, cols) of the output grid for a step in degrees (matches `grid.resample`)."""
    return int(round(180 / res)) + 1, int(round(360 / res))


def _field(n: models.Native):
    from .grib import Field

    return Field(n.u, n.v, n.lats, n.lons, n.d)


def _dump(obj) -> bytes:
    return (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode()


def strip_private(latest: dict) -> dict:
    return {k: v for k, v in latest.items() if not k.startswith("_")}


# ---- legacy v1 (GFS 10 m wind) --------------------------------------------------------------


def write_legacy_wind(out_dir: str, latest: dict, keep: int = 2) -> Optional[dict]:
    """CONTRACTS 1 compatibility alias: wind/<run>/fFFF.png + wind/latest.json, byte-identical
    10 m wind frames of GFS (same encoding: u/v +-50, speed_max 70). Returns the v1 dict."""
    fld = next((f for f in latest["fields"] if f["slug"] == "wind_10m"), None)
    if latest["model"] != "gfs" or fld is None:
        return None
    rid = gfs.run_id_from_iso(latest["run"])
    frames = []
    for fr in fld["frames"]:
        src = os.path.join(out_dir, fr["png"])
        rel = f"wind/{rid}/f{fr['fhr']:03d}.png"
        dst = os.path.join(out_dir, rel)
        if not _valid_png(dst) or os.path.getsize(dst) != os.path.getsize(src):
            with open(src, "rb") as fh:
                encode.atomic_write(dst, fh.read())
        frames.append({"fhr": fr["fhr"], "valid": fr["valid"], "png": rel, "bytes": fr["bytes"]})
    g = latest["grid"]
    v1 = {
        "schema": 1,
        "source": "NOAA GFS 0.25°",
        "licence": "US Government work, public domain",
        "level": "10m",
        "units": "m/s",
        "run": latest["run"],
        "generated": latest["generated"],
        "image": {
            "width": g["width"],
            "height": g["height"],
            "lon_left": -180,
            "lon_right": g["lon_right"],
            "lat_top": 90,
            "lat_bottom": -90,
            "u": {"min": -50, "max": 50},
            "v": {"min": -50, "max": 50},
            "speed_max": 70,
        },
        "frames": frames,
    }
    encode.atomic_write(os.path.join(out_dir, "wind", "latest.json"), _dump(v1))
    prune(os.path.join(out_dir, "wind"), keep, rid)
    return v1


# ---- catalogue ------------------------------------------------------------------------------


def index_entry(model: Model, latest: dict) -> dict:
    return {
        "id": model.id,
        "name": model.name,
        "licence": model.licence,
        "run": latest["run"],
        "latest": f"weather/{model.id}/latest.json",
    }


def write_index(out_dir: str, entries: List[dict]) -> dict:
    """Merge `entries` into weather/index.json (models not processed this time are kept), LAST."""
    path = os.path.join(out_dir, "weather", "index.json")
    cur = []
    try:
        with open(path) as fh:
            cur = json.load(fh).get("models", [])
    except (OSError, ValueError):
        pass
    byid = {e["id"]: e for e in cur if os.path.exists(os.path.join(out_dir, e["latest"]))}
    byid.update({e["id"]: e for e in entries})
    order = list(models.MODELS)
    ms = sorted(byid.values(), key=lambda e: order.index(e["id"]) if e["id"] in order else 99)
    idx = {"schema": 2, "generated": dt.datetime.now(dt.timezone.utc).strftime(ISO), "models": ms}
    encode.atomic_write(path, _dump(idx))
    return idx


def ingest_all(
    out_dir: str,
    model_list: Sequence[Model],
    specs: Sequence[FieldSpec],
    *,
    runs: Optional[Dict[str, dt.datetime]] = None,
    dry_run: bool = False,
    keep: int = 2,
    **kw,
) -> dict:
    """Run every model (a failing model is reported and does not block the others)."""
    runs = runs or {}
    results: Dict[str, dict] = {}
    errors: Dict[str, str] = {}
    legacy = None
    entries = []
    for m in model_list:
        try:
            lat = ingest_model(
                m, out_dir, specs, run=runs.get(m.id), dry_run=dry_run, keep=keep, **kw
            )
        except Exception as e:  # keep going: one model's outage must not stop the others
            log.error("[%s] FAILED: %s", m.id, e)
            errors[m.id] = str(e)
            continue
        if lat is None:
            continue
        results[m.id] = lat
        entries.append(index_entry(m, lat))
        if m.id == "gfs":
            legacy = write_legacy_wind(out_dir, lat, keep)
    index = write_index(out_dir, entries) if entries else None
    return {"models": results, "errors": errors, "legacy": legacy, "index": index}


def report(res: dict) -> str:
    """Human-readable size / download / time summary of an `ingest_all` result."""
    lines = []
    for mid, lat in res["models"].items():
        st = lat["_stats"]
        lines.append(
            f"{mid}  run {lat['run']}  wall {st['wall_s']:.0f}s  download "
            f"{st['download_bytes'] / 1e6:.1f} MB ({st['requests']} requests)  PNG "
            f"{st['png_bytes'] / 1e6:.1f} MB"
        )
        for slug, f in st["per_field"].items():
            lines.append(
                f"    {slug:10s} {f['frames']:3d} frames  avg {f['avg'] / 1e3:7.1f} kB  "
                f"total {f['bytes'] / 1e6:6.2f} MB"
            )
    for mid, err in res["errors"].items():
        lines.append(f"{mid}  FAILED: {err}")
    return "\n".join(lines)
