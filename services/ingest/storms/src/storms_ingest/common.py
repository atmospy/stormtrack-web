"""Shared helpers: category labels, JSON/atomic IO, time formatting, dateline handling."""

from __future__ import annotations

import gzip
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional, Sequence

import pandas as pd

# Saffir-Simpson lower bounds in knots (1-minute sustained wind). Order matters.
SAFFIR_SIMPSON = [("TD", 0), ("TS", 34), ("C1", 64), ("C2", 83), ("C3", 96), ("C4", 113), ("C5", 137)]
CATEGORY_LABELS = [lab for lab, _ in SAFFIR_SIMPSON]


def category(wind_kt) -> Optional[str]:
    """Saffir-Simpson label for a wind in knots (None when unknown).

    TD < 34, TS 34-63, C1 64-82, C2 83-95, C3 96-112, C4 113-136, C5 >= 137.
    """
    if wind_kt is None or (isinstance(wind_kt, float) and math.isnan(wind_kt)):
        return None
    label = "TD"
    for lab, lo in SAFFIR_SIMPSON:
        if wind_kt >= lo:
            label = lab
    return label


def cat_obj(wind_kt) -> Optional[dict]:
    lab = category(wind_kt)
    return None if lab is None else {"scale": "saffir-simpson", "label": lab}


def iso(t) -> Optional[str]:
    """UTC ISO-8601 with trailing Z."""
    if t is None or (not isinstance(t, str) and pd.isna(t)):
        return None
    ts = pd.Timestamp(t)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def num(x, nd: Optional[int] = None):
    """float/int or None for NaN/None; optionally rounded."""
    if x is None:
        return None
    try:
        if pd.isna(x):
            return None
    except (TypeError, ValueError):
        pass
    x = float(x)
    if nd is None:
        return int(x) if x == int(x) else x
    return round(x, nd)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_json(path: Path, obj, indent: Optional[int] = None) -> int:
    """Atomically write compact JSON; returns the byte size."""
    data = json.dumps(obj, separators=(",", ":"), allow_nan=False, indent=indent).encode()
    atomic_write_bytes(path, data)
    return len(data)


def gz_size(path: Path) -> int:
    return len(gzip.compress(Path(path).read_bytes(), compresslevel=6))


# --- antimeridian handling -------------------------------------------------


def split_antimeridian(
    lons: Sequence[float],
    lats: Sequence[float],
    values: Optional[dict] = None,
):
    """Split a polyline at +-180 so no segment jumps across the map.

    ``lons`` are in [-180, 180]. Crossing points are interpolated and added to both
    parts. ``values`` maps name -> per-vertex numeric list (None allowed); they are
    interpolated at the crossing vertices (None if either neighbour is None).

    Returns ``(parts, vals)``: ``parts`` is a list of ``[(lon, lat), ...]`` and
    ``vals[name]`` the matching flat list of per-vertex values in part order.
    """
    values = values or {}
    parts: list = [[]]
    vals = {k: [] for k in values}

    def push(i, lon, lat, interp=None):
        parts[-1].append((lon, lat))
        for k, arr in values.items():
            vals[k].append(interp[k] if interp is not None else arr[i])

    for i in range(len(lons)):
        if i > 0 and abs(lons[i] - lons[i - 1]) > 180:
            lon0, lon1 = lons[i - 1], lons[i]
            # unwrap lon1 to be continuous with lon0, find the +-180 crossing
            lon1u = lon1 + 360 if lon1 < lon0 else lon1 - 360
            edge = 180.0 if lon1u > lon0 else -180.0
            f = (edge - lon0) / (lon1u - lon0)
            lat_c = lats[i - 1] + f * (lats[i] - lats[i - 1])
            interp = {}
            for k, arr in values.items():
                a, b = arr[i - 1], arr[i]
                interp[k] = _lerp(a, b, f)
            push(i - 1, edge, lat_c, interp)
            parts.append([])
            push(i, -edge, lat_c, interp)
        push(i, lons[i], lats[i])
    return parts, vals


def _lerp(a, b, f):
    if a is None or b is None:
        return None
    if isinstance(a, str):  # ISO time strings
        ta, tb = pd.Timestamp(a), pd.Timestamp(b)
        return iso(ta + (tb - ta) * f)
    return a + (b - a) * f


def line_geometry(parts: list) -> dict:
    """LineString for one part, MultiLineString for several. Drops degenerate parts."""
    parts = [[[round(x, 4), round(y, 4)] for x, y in p] for p in parts if len(p) >= 2]
    if len(parts) == 1:
        return {"type": "LineString", "coordinates": parts[0]}
    return {"type": "MultiLineString", "coordinates": parts}


def iter_coords(geom: dict) -> Iterable:
    t, c = geom["type"], geom["coordinates"]
    if t == "Point":
        yield tuple(c)
    elif t == "LineString":
        yield from map(tuple, c)
    elif t in ("MultiLineString", "Polygon"):
        for part in c:
            yield from map(tuple, part)
    elif t == "MultiPolygon":
        for poly in c:
            for ring in poly:
                yield from map(tuple, ring)
