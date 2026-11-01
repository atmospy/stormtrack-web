"""Fetch + normalise each hazard source to GeoJSON FeatureCollections (CONTRACTS section 3)."""

from __future__ import annotations

import csv
import logging
import io
import json
import math
import os
from typing import Callable, Optional

from .common import http_get, ms_iso, now_iso

log = logging.getLogger(__name__)

EONET_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days={days}"
USGS_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson"
EONET_VOLCANO_URL = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=volcanoes"
FIRMS_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{product}/world/{days}"
FIRMS_PRODUCT = "VIIRS_SNPP_NRT"
FIRMS_MAX_POINTS = 20_000

EONET_KIND = {
    "wildfires": "wildfire",
    "volcanoes": "volcano",
    "floods": "flood",
    "severeStorms": "storm",
    "earthquakes": "quake",
}
EONET_LICENCE = "NASA EONET (open data, https://eonet.gsfc.nasa.gov/)"
USGS_LICENCE = "USGS (public domain)"


def _collection(features: list, **extra) -> dict:
    return {"type": "FeatureCollection", "generated": now_iso(), **extra, "features": features}


# --- NASA EONET -------------------------------------------------------------


def _ring_centroid(ring: list) -> tuple:
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _point_of(geom: dict) -> Optional[tuple]:
    if geom["type"] == "Point":
        return tuple(geom["coordinates"][:2])
    if geom["type"] == "Polygon":
        return _ring_centroid(geom["coordinates"][0])
    return None


def normalize_eonet(raw: dict) -> dict:
    """EONET v3 events -> one Point feature per event at its latest geometry.

    Polygons are reduced to their centroid; the full geometry history (storm / iceberg
    tracks) is not published.
    """
    feats = []
    for e in raw.get("events", []):
        geoms = [g for g in e.get("geometry", []) if g.get("date")]
        if not geoms:
            continue
        g = max(geoms, key=lambda g: g["date"])
        pt = _point_of(g)
        if pt is None or not (-180 <= pt[0] <= 180 and -90 <= pt[1] <= 90):
            continue
        cats = [c["id"] for c in e.get("categories", [])]
        kind = next((EONET_KIND[c] for c in cats if c in EONET_KIND), "other")
        srcs = e.get("sources", [])
        props = {
            "id": e["id"],
            "kind": kind,
            "title": e.get("title"),
            "time": g["date"] if g["date"].endswith("Z") else g["date"] + "Z",
            "url": e.get("link") or (srcs[0]["url"] if srcs else None),
            "source": "NASA EONET",
            "category": cats[0] if cats else None,
            "origin": [s.get("id") for s in srcs],
        }
        if g.get("magnitudeValue") is not None:
            props["magnitude"] = {"value": g["magnitudeValue"], "unit": g.get("magnitudeUnit")}
        if srcs and srcs[0].get("url"):
            props["origin_url"] = srcs[0]["url"]
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(pt[0], 4), round(pt[1], 4)]},
                      "properties": props})
    feats.sort(key=lambda f: f["properties"]["time"], reverse=True)
    return _collection(feats, licence=EONET_LICENCE, attribution="NASA EONET")


def fetch_eonet(days: int = 30, get: Callable = http_get) -> dict:
    """Recent activity plus long-lived volcano events.

    ``status=open`` alone returns every never-closed event with its whole geometry
    history (7k+ mostly stale IRWIN wildfires, >5 MB, ~3 minutes), so we ask for events
    with activity in the last ``days`` days and add the (small) open-volcano list, since
    volcano entries are updated only occasionally and would otherwise drop out.
    """
    raw = json.loads(get(EONET_URL.format(days=days), timeout=180))
    try:
        extra = json.loads(get(EONET_VOLCANO_URL, timeout=90))
        have = {e["id"] for e in raw.get("events", [])}
        raw["events"] = raw.get("events", []) + [e for e in extra.get("events", []) if e["id"] not in have]
    except Exception as exc:  # noqa: BLE001 - volcanoes are a bonus
        log.warning("EONET volcano list unavailable: %s", exc)
    return normalize_eonet(raw)


# --- USGS earthquakes -------------------------------------------------------


def normalize_usgs(raw: dict) -> dict:
    feats = []
    for f in raw.get("features", []):
        p, c = f["properties"], f["geometry"]["coordinates"]
        if p.get("mag") is None or p.get("time") is None:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(c[0], 4), round(c[1], 4)]},
            "properties": {
                "id": f["id"], "kind": "quake", "title": p.get("title") or f"M {p['mag']}", "time": ms_iso(p["time"]),
                "url": p.get("url"), "source": "USGS", "mag": p["mag"],
                "depth_km": round(c[2], 1) if len(c) > 2 and c[2] is not None else None,
                "place": p.get("place"), "tsunami": bool(p.get("tsunami")),
            },
        })
    feats.sort(key=lambda f: f["properties"]["time"], reverse=True)
    return _collection(feats, licence=USGS_LICENCE, attribution="U.S. Geological Survey")


def fetch_usgs(get: Callable = http_get) -> dict:
    return normalize_usgs(json.loads(get(USGS_URL)))


# --- NASA FIRMS -------------------------------------------------------------

_CONF = {"l": "low", "n": "nominal", "h": "high"}


def _confidence(v: str) -> str:
    v = (v or "").strip().lower()
    if v in _CONF:
        return _CONF[v]
    try:
        n = float(v)
    except ValueError:
        return "nominal"
    return "low" if n < 30 else "nominal" if n < 80 else "high"


def normalize_firms(csv_text: str, product: str = FIRMS_PRODUCT, max_points: int = FIRMS_MAX_POINTS) -> dict:
    """Grid-dedupe hotspots to <= ``max_points`` points.

    Cells start at 0.05 deg and are doubled until the count fits; each cell keeps its
    most intense detection (max FRP) and the number of detections it absorbed.
    """
    rows = []
    for r in csv.DictReader(io.StringIO(csv_text)):
        try:
            lat, lon, frp = float(r["latitude"]), float(r["longitude"]), float(r.get("frp") or 0)
        except (KeyError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        hhmm = (r.get("acq_time") or "0000").zfill(4)
        rows.append((lat, lon, frp, f"{r.get('acq_date', '')}T{hhmm[:2]}:{hhmm[2:]}:00Z", _confidence(r.get("confidence", ""))))
    cell = 0.05
    while True:
        best: dict = {}
        for lat, lon, frp, t, conf in rows:
            k = (math.floor(lat / cell), math.floor(lon / cell))
            cur = best.get(k)
            if cur is None:
                best[k] = [lat, lon, frp, t, conf, 1]
            else:
                cur[5] += 1
                if frp > cur[2]:
                    cur[:5] = [lat, lon, frp, t, conf]
        if len(best) <= max_points or cell > 8:
            break
        cell *= 2
    pts = sorted(best.values(), key=lambda v: -v[2])[:max_points]
    feats = [{
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [round(p[1], 3), round(p[0], 3)]},
        "properties": {
            "id": f"firms-{p[0]:.3f}_{p[1]:.3f}", "kind": "wildfire", "title": "Fire hotspot", "time": p[3],
            "url": "https://firms.modaps.eosdis.nasa.gov/map/", "source": f"NASA FIRMS {product}",
            "frp": round(p[2], 1), "confidence": p[4], "detections": p[5],
        }} for p in pts]
    return _collection(feats, licence="NASA FIRMS (open data, https://firms.modaps.eosdis.nasa.gov/)",
                       attribution="NASA FIRMS / LANCE", raw_detections=len(rows), grid_deg=cell)


def fetch_firms(key: str, days: int = 1, product: str = FIRMS_PRODUCT, get: Callable = http_get) -> dict:
    text = get(FIRMS_URL.format(key=key, product=product, days=days), timeout=300).decode("utf-8", "replace")
    if not text.lstrip().lower().startswith("latitude"):
        # FIRMS returns plain-text errors (invalid key, rate limit) with HTTP 200
        raise RuntimeError(f"FIRMS returned an error: {text.strip()[:120]!r}".replace(key, "<key>"))
    return normalize_firms(text, product)
