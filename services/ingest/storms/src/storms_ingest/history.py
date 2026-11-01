"""Historical tracks -> ``storms/history/<basin>.geojson``.

Each storm is one (Multi)LineString, simplified with Douglas-Peucker (tolerance
``SIMPLIFY_DEG`` degrees, applied in a longitude frame unwrapped across the dateline)
and rounded to 2 decimals. Tracks that cross the antimeridian are **split** into a
MultiLineString at +-180 (crossing points interpolated), so every coordinate stays in
[-180, 180] and the map never draws a line across the whole world.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from shapely.geometry import LineString

from .common import category, iso, num, split_antimeridian

SIMPLIFY_DEG = 0.05


def simplify_track(lons, lats, tol: float = SIMPLIFY_DEG):
    """Douglas-Peucker on an unwrapped copy; returns wrapped (lon, lat) vertex lists."""
    lon_u = np.degrees(np.unwrap(np.radians(np.asarray(lons, float))))
    ls = LineString(np.column_stack([lon_u, lats]))
    s = ls.simplify(tol, preserve_topology=False)
    xy = np.asarray(s.coords)
    lon = (xy[:, 0] + 180) % 360 - 180
    # keep +180 as +180 (not -180) when the original used it
    return [float(x) for x in lon], [float(y) for y in xy[:, 1]]


def _geometry(lons, lats) -> dict:
    parts, _ = split_antimeridian(lons, lats)
    parts = [[(round(x, 2), round(y, 2)) for x, y in p] for p in parts]
    # rounding can collapse a part to duplicates; drop consecutive duplicates
    cleaned = []
    for p in parts:
        q = [p[0]]
        for pt in p[1:]:
            if pt != q[-1]:
                q.append(pt)
        if len(q) >= 2:
            cleaned.append([list(pt) for pt in q])
    if not cleaned:
        return None
    if len(cleaned) == 1:
        return {"type": "LineString", "coordinates": cleaned[0]}
    return {"type": "MultiLineString", "coordinates": cleaned}


def _basin(m, fallback):
    b = m.get("basin") if hasattr(m, "get") else None
    return fallback if b is None or pd.isna(b) else str(b)


def build_history(obs: pd.DataFrame, storms: pd.DataFrame, basin: str = None) -> tuple:
    """FeatureCollection of simplified storms; returns ``(collection, skipped_ids)``.

    Each feature carries ``basin`` (the storm's IBTrACS genesis basin; ``basin`` is the fallback
    when the frame has no such column).
    """
    feats, skipped = [], []
    meta = storms.set_index("storm_id")
    for sid, o in obs.sort_values(["storm_id", "time"]).groupby("storm_id", sort=False):
        o = o.dropna(subset=["lat", "lon"])
        if len(o) < 2:
            skipped.append(sid)
            continue
        lons, lats = simplify_track(o["lon"].to_numpy(), o["lat"].to_numpy())
        geom = _geometry(lons, lats)
        if geom is None:
            skipped.append(sid)
            continue
        m = meta.loc[sid]
        maxw = num(m["max_wind"])
        grade = m["peak_grade"]
        feats.append(
            {
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "id": str(sid),
                    "basin": _basin(m, basin),
                    "name": None if pd.isna(m["name"]) else str(m["name"]),
                    "year": int(m["year"]),
                    "max_wind_kt": maxw,
                    "category": category(maxw),
                    "imd_grade": None if pd.isna(grade) else str(grade),
                    "start": iso(m["start_time"]),
                    "end": iso(m["end_time"]),
                },
            }
        )
    feats.sort(key=lambda f: (f["properties"]["year"], f["properties"]["start"]))
    return {"type": "FeatureCollection", "features": feats}, skipped
