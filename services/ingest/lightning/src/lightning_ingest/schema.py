"""Validator for the CONTRACTS section 6 files. Returns a list of problems (empty = valid)."""

from __future__ import annotations

import re

ISO_Z = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
COLS = ["dt_s", "lon", "lat", "energy_fj", "src"]
KINDS = ("satellite", "ground-network")
PRECISIONS = ("exact", "bucketed")
SOURCE_KEYS = (
    "id",
    "name",
    "licence",
    "attribution",
    "kind",
    "time_precision",
    "time_uncertainty_s",
    "unofficial",
    "latency_s",
    "stale",
    "updated",
    "coverage",
)


def validate_flashes(d: dict, dps: list | None = None) -> list:
    """``dps``: lon/lat decimals per source (index order); also gives the valid ``src`` range."""
    p = []
    if d.get("schema") != 1:
        p.append("flashes.schema != 1")
    if not ISO_Z.match(str(d.get("t0", ""))):
        p.append("flashes.t0 not ISO Z")
    if d.get("cols") != COLS:
        p.append(f"flashes.cols != {COLS}")
    rows = d.get("rows")
    if not isinstance(rows, list):
        return p + ["flashes.rows not a list"]
    last = None
    for i, r in enumerate(rows):
        if len(r) != len(COLS):
            p.append(f"row {i} has {len(r)} columns")
            break
        dt, lon, lat, e, src = r
        if not (isinstance(src, int) and not isinstance(src, bool) and src >= 0):
            p.append(f"row {i} src not a non-negative int")
            break
        if dps is not None and src >= len(dps):
            p.append(f"row {i} src {src} out of range")
            break
        if not (-180 <= lon <= 180 and -90 <= lat <= 90):
            p.append(f"row {i} lon/lat out of range")
            break
        dp = dps[src] if dps is not None else 4
        if round(lon, dp) != lon or round(lat, dp) != lat:
            p.append(f"row {i} lon/lat not rounded to {dp} dp")
            break
        if dt < 0 or (last is not None and dt < last):
            p.append(f"row {i} not sorted by time / negative dt")
            break
        if e is not None and not (isinstance(e, (int, float)) and e >= 0 and e == e):
            p.append(f"row {i} energy invalid (must be null or >= 0)")
            break
        last = dt
    return p


def validate_recent(d: dict) -> list:
    p = []
    if d.get("schema") != 1:
        p.append("recent.schema != 1")
    if not ISO_Z.match(str(d.get("generated", ""))):
        p.append("recent.generated not ISO Z")
    if d.get("cols") != ["id", "t_ms", "lon", "lat", "energy_fj", "src"]:
        p.append("recent.cols wrong")
    rows = d.get("rows")
    if not isinstance(rows, list):
        return p + ["recent.rows not a list"]
    ids = set()
    for i, r in enumerate(rows):
        if len(r) != 6 or not isinstance(r[0], str) or r[0] in ids:
            p.append(f"recent row {i} malformed or duplicate id")
            break
        ids.add(r[0])
        if r[4] is not None and not (r[4] >= 0):
            p.append(f"recent row {i} energy invalid")
            break
    return p


def _ring_ok(ring) -> bool:
    return len(ring) >= 4 and ring[0] == ring[-1]


def validate_coverage(d: dict, source_ids: list | None = None) -> list:
    """With ``source_ids``: exactly one feature per source (``properties.source``)."""
    p = []
    if d.get("type") != "FeatureCollection":
        return ["coverage is not a FeatureCollection"]
    feats = d.get("features") or []
    if not feats:
        p.append("coverage has no features")
    for f in feats:
        g = f.get("geometry") or {}
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            p.append("coverage geometry must be Polygon/MultiPolygon")
            continue
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        if not all(_ring_ok(r) for poly in polys for r in poly):
            p.append("coverage ring not closed")
        props = f.get("properties") or {}
        if not props.get("approximate"):
            p.append("coverage must be labelled approximate")
        if not props.get("basis"):
            p.append("coverage feature needs a basis text")
    if source_ids is not None:
        got = [(f.get("properties") or {}).get("source") for f in feats]
        if sorted(map(str, got)) != sorted(source_ids):
            p.append(f"coverage features {got} != sources {source_ids}")
    return p


def validate_index(d: dict) -> list:
    p = []
    if d.get("schema") != 1:
        p.append("index.schema != 1")
    for k in ("generated", "updated"):
        if not ISO_Z.match(str(d.get(k, ""))):
            p.append(f"index.{k} not ISO Z")
    if not isinstance(d.get("window_minutes"), int):
        p.append("index.window_minutes not int")
    if not isinstance(d.get("count"), int):
        p.append("index.count not int")
    if not isinstance(d.get("notes"), str) or not d["notes"]:
        p.append("index.notes missing")
    live = d.get("live")
    if live is not None and not (
        isinstance(live, dict)
        and isinstance(live.get("delay_s"), (int, float))
        and isinstance(live.get("poll_s"), (int, float))
    ):
        p.append("index.live must be {delay_s, poll_s}")
    if "stale" in d and not isinstance(d["stale"], bool):
        p.append("index.stale not bool")
    srcs = d.get("sources")
    if not isinstance(srcs, list) or not srcs:
        p.append("index.sources missing")
    else:
        ids = [s.get("id") for s in srcs]
        if len(set(ids)) != len(ids):
            p.append("duplicate source ids")
        for s in srcs:
            for k in SOURCE_KEYS:
                if k not in s:
                    p.append(f"source {s.get('id')} missing {k}")
            if s.get("kind") not in KINDS:
                p.append(f"source {s.get('id')} kind invalid")
            if s.get("time_precision") not in PRECISIONS:
                p.append(f"source {s.get('id')} time_precision invalid")
            if s.get("kind") == "satellite" and not isinstance(s.get("satellites"), list):
                p.append(f"source {s.get('id')} missing satellites")
            for k in ("stale", "unofficial"):
                if k in s and not isinstance(s[k], bool):
                    p.append(f"source {s.get('id')} {k} not bool")
            u = s.get("updated")
            if u is not None and not ISO_Z.match(str(u)):
                p.append(f"source {s.get('id')} updated not ISO Z")
        if all("stale" in s for s in srcs) and d.get("stale") != all(s["stale"] for s in srcs):
            p.append("index.stale must equal 'every source stale'")
    return p


def validate_all(index: dict, flashes: dict, coverage: dict) -> list:
    srcs = index.get("sources") if isinstance(index.get("sources"), list) else []
    ids = [s.get("id") for s in srcs]
    dps = [s.get("lon_lat_dp", 4) for s in srcs] if srcs else None
    p = (
        validate_index(index)
        + validate_flashes(flashes, dps)
        + validate_coverage(coverage, ids if srcs else None)
    )
    if not p and index["count"] != len(flashes["rows"]):
        p.append("index.count != len(rows)")
    return p
