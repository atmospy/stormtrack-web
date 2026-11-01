"""Validators for the CONTRACTS section 2 files. Return a list of problems ([] = valid)."""

from __future__ import annotations

import re

from .basins import BASINS
from .common import CATEGORY_LABELS, iter_coords

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
GEOMS = {"Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"}


def _isoz(v) -> bool:
    return isinstance(v, str) and bool(ISO_Z.match(v))


def _coords_ok(geom, errs, where):
    if geom.get("type") not in GEOMS:
        errs.append(f"{where}: bad geometry type {geom.get('type')}")
        return
    for c in iter_coords(geom):
        if len(c) < 2 or not (-180 <= c[0] <= 180 and -90 <= c[1] <= 90):
            errs.append(f"{where}: coordinate out of range {c}")
            return


def _cat(v) -> bool:
    return (
        isinstance(v, dict)
        and v.get("scale") == "saffir-simpson"
        and v.get("label") in CATEGORY_LABELS
    )


def _num_or_none(v) -> bool:
    return v is None or (isinstance(v, (int, float)) and not isinstance(v, bool))


def validate_active(fc: dict) -> list:
    errs = []
    if fc.get("type") != "FeatureCollection":
        return ["not a FeatureCollection"]
    ids_pos = set()
    for i, f in enumerate(fc["features"]):
        p, g, w = f["properties"], f["geometry"], f"feature {i}"
        _coords_ok(g, errs, w)
        k = p.get("kind")
        if k == "position":
            ids_pos.add(p["id"])
            if g["type"] != "Point":
                errs.append(f"{w}: position must be Point")
            for key in (
                "id",
                "name",
                "basin",
                "agency",
                "time",
                "wind_kt",
                "pressure_hpa",
                "category",
                "heading_deg",
                "speed_kmh",
                "wind_period_min",
            ):
                if key not in p:
                    errs.append(f"{w}: missing {key}")
            if p.get("agency") not in ("NHC", "JTWC"):
                errs.append(f"{w}: bad agency")
            if not _isoz(p.get("time")):
                errs.append(f"{w}: bad time")
            if p.get("wind_period_min") != 1:
                errs.append(f"{w}: wind_period_min must be 1")
            if p.get("category") is not None and not _cat(p["category"]):
                errs.append(f"{w}: bad category")
            for key in ("wind_kt", "pressure_hpa", "heading_deg", "speed_kmh"):
                if not _num_or_none(p.get(key)):
                    errs.append(f"{w}: {key} not numeric")
        elif k == "track":
            n = sum(1 for _ in iter_coords(g))
            if g["type"] not in ("LineString", "MultiLineString"):
                errs.append(f"{w}: track geometry")
            if len(p.get("times", [])) != n or len(p.get("wind_kt", [])) != n:
                errs.append(f"{w}: track per-vertex arrays do not match {n} vertices")
            if not all(_isoz(t) for t in p.get("times", [])):
                errs.append(f"{w}: bad track times")
        elif k == "forecast":
            n = sum(1 for _ in iter_coords(g))
            for key in ("taus", "wind_kt", "category"):
                if len(p.get(key, [])) != n:
                    errs.append(f"{w}: forecast {key} length != {n}")
            if not _isoz(p.get("init")) or not p.get("tech"):
                errs.append(f"{w}: forecast init/tech")
            if not all(c is None or c in CATEGORY_LABELS for c in p.get("category", [])):
                errs.append(f"{w}: forecast category labels")
        elif k == "cone":
            if g["type"] not in ("Polygon", "MultiPolygon"):
                errs.append(f"{w}: cone geometry")
            if len(p.get("radii_km", [])) != len(p.get("taus", [])) or not p.get("basis"):
                errs.append(f"{w}: cone radii/basis")
        else:
            errs.append(f"{w}: unknown kind {k}")
    for f in fc["features"]:
        if f["properties"]["id"] not in ids_pos:
            errs.append(f"{f['properties']['id']}: feature without position")
    return errs


def validate_history(fc: dict, basin: str = None) -> list:
    errs = []
    if fc.get("type") != "FeatureCollection":
        return ["not a FeatureCollection"]
    seen = set()
    for i, f in enumerate(fc["features"]):
        p, w = f["properties"], f"storm {i}"
        _coords_ok(f["geometry"], errs, w)
        if f["geometry"]["type"] not in ("LineString", "MultiLineString"):
            errs.append(f"{w}: geometry type")
        for key in (
            "id",
            "basin",
            "name",
            "year",
            "max_wind_kt",
            "category",
            "imd_grade",
            "start",
            "end",
        ):
            if key not in p:
                errs.append(f"{w}: missing {key}")
        if p.get("basin") not in BASINS or (basin and p.get("basin") != basin):
            errs.append(f"{w}: bad basin {p.get('basin')!r}")
        if not isinstance(p.get("year"), int) or not (1800 <= p["year"] <= 2100):
            errs.append(f"{w}: bad year")
        if p["id"] in seen:
            errs.append(f"{w}: duplicate id")
        seen.add(p["id"])
        if not (_isoz(p.get("start")) and _isoz(p.get("end")) and p["start"] <= p["end"]):
            errs.append(f"{w}: start/end")
        if p.get("category") is not None and p["category"] not in CATEGORY_LABELS:
            errs.append(f"{w}: category")
        parts = (
            f["geometry"]["coordinates"]
            if f["geometry"]["type"] == "MultiLineString"
            else [f["geometry"]["coordinates"]]
        )
        if any(len(part) < 2 for part in parts):
            errs.append(f"{w}: degenerate line part")
        for c in iter_coords(f["geometry"]):
            if round(c[0], 2) != c[0] or round(c[1], 2) != c[1]:
                errs.append(f"{w}: coordinates not rounded to 2 dp")
                break
    return errs


def validate_stats(s: dict) -> list:
    errs = []
    for key in ("annual", "monthly", "rapid_intensification", "lifetime_max", "notes"):
        if key not in s:
            errs.append(f"missing {key}")
    if errs:
        return errs
    for a in s["annual"]:
        if set(a) != {"year", "storms", "tropical_storm", "hurricane", "major", "ace"}:
            errs.append(f"annual keys {sorted(a)}")
            break
    if [m["month"] for m in s["monthly"]] != list(range(1, 13)):
        errs.append("monthly must cover months 1..12")
    for r in s["rapid_intensification"]:
        if set(r) != {"id", "name", "year", "max_dwind_kt_24h"}:
            errs.append("rapid_intensification keys")
            break
    for r in s["lifetime_max"]:
        if set(r) != {"id", "name", "year", "wind_kt", "lat", "lon"} or not (
            -90 <= r["lat"] <= 90 and -180 <= r["lon"] <= 180
        ):
            errs.append("lifetime_max keys/range")
            break
    if len(s["notes"]) < 50:
        errs.append("notes too short")
    return errs


def validate_index(ix: dict) -> list:
    errs = []
    if ix.get("schema") != 1 or not _isoz(ix.get("generated")):
        errs.append("schema/generated")
    a = ix.get("active")
    if not a or not {"count", "updated", "sources"} <= set(a) or not _isoz(a.get("updated")):
        errs.append("active block")
    for b, h in ix.get("history", {}).items():
        if b not in BASINS:
            errs.append(f"history: unknown basin {b}")
        if not {"count", "year_min", "year_max", "sources"} <= set(h):
            errs.append(f"history {b} block")
        elif not {"name", "file", "stats", "bytes", "gzip_bytes"} <= set(h):
            errs.append(f"history {b} block lacks Round 2 fields")
        elif h["file"] != f"storms/history/{b}.geojson" or h["stats"] != f"storms/stats/{b}.json":
            errs.append(f"history {b} paths")
    return errs


def validate_all_index(ai: dict) -> list:
    """``storms/history/all-index.json`` (CONTRACTS section 2, Round 2)."""
    errs = []
    if ai.get("schema") != 1 or not _isoz(ai.get("generated")):
        errs.append("schema/generated")
    rows = ai.get("basins")
    if not isinstance(rows, list) or not rows:
        return errs + ["basins missing"]
    keys = {"id", "name", "count", "year_min", "year_max", "file", "stats", "bytes", "gzip_bytes"}
    seen = set()
    for r in rows:
        if not keys <= set(r):
            errs.append(f"row {r.get('id')}: missing {sorted(keys - set(r))}")
            continue
        if r["id"] not in BASINS or r["id"] in seen:
            errs.append(f"bad/duplicate basin {r['id']}")
        seen.add(r["id"])
        if r["file"] != f"storms/history/{r['id']}.geojson" or r["stats"] != (
            f"storms/stats/{r['id']}.json"
        ):
            errs.append(f"row {r['id']}: paths")
        if not (r["count"] > 0 and r["year_min"] <= r["year_max"] and r["gzip_bytes"] > 0):
            errs.append(f"row {r['id']}: values")
    if ai.get("total_gzip_bytes") != sum(r["gzip_bytes"] for r in rows if "gzip_bytes" in r):
        errs.append("total_gzip_bytes")
    return errs
