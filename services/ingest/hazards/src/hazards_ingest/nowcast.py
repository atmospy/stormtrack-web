"""India district nowcast warnings from IMD's public map service (UNDOCUMENTED) -> ``nowcast/latest.geojson``.

The Mausam app draws its nowcast layer from ``imd_ws:nc_district`` on IMD's GeoServer. Read as WFS
GeoJSON it holds one MultiPolygon per district (747, IMD's own boundaries) with::

    State_District   "BARAGARH"
    Date             "2026-11-02"            issue date (Indian time)
    toi, vupto       1900, 2200              issued / valid up to, HHMM Indian time
    ws_cond          "$$$$$$Moderate rain: 5-15 mm/hr$$Moderate Thunderstorms ...$$#"   warning texts joined by $
    color_hex        "#228b22" green (no warning), "#ffbf00" amber, "#ff7900" orange

(checked 2 Nov 2026: 570 green, 154 amber, 23 orange). Only districts with a CURRENT warning are
published, with the shapes rounded to 3 decimals (~100 m) and simplified (0.01 deg, ~1 km), which
turns a 4.4 MB response into a small file. Levels follow IMD's colours: amber 1, orange 2 and any
other non-green colour 3; the words come from IMD's own texts.

No terms of use are published for this service; it is the data source of IMD's own app, read here
once per run from a descriptive User-Agent (never by visitors' browsers), and the output credits IMD.
A failed or unrecognisable response leaves the previous published file untouched.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .common import atomic_write_bytes, gz_size, http_get, now_iso

log = logging.getLogger("ingest-nowcast")

URL = (
    "https://hgmg.imd.gov.in:8443/geoserver/imd_ws/ows?service=WFS&version=1.0.0&request=GetFeature"
    "&typeName=imd_ws:nc_district&outputFormat=application/json"
)
IST = timezone(timedelta(hours=5, minutes=30))
NO_WARNING = "#228b22"
LEVEL_BY_COLOR = {"#ffbf00": 1, "#ff7900": 2}
ROUND_DP = 3
SIMPLIFY_DEG = 0.01
STALE_AFTER_H = 12
LICENCE = (
    "No published licence or terms for this service; used as the data source of IMD's own app, "
    "fetched server-side on a schedule; credit IMD. Written permission has not been requested."
)
ATTRIBUTION = "Nowcast warnings: India Meteorological Department (IMD)"


def level_for(color: str | None) -> int | None:
    """Warning level for an IMD colour; None for green (no warning) or a missing colour."""
    c = (color or "").strip().lower()
    if not c or c == NO_WARNING:
        return None
    return LEVEL_BY_COLOR.get(c, 3)


def warning_texts(ws_cond: str | None) -> list:
    """The warning texts of ``ws_cond`` (slots joined by ``$``, ended by ``#``), in order."""
    out = []
    for part in (ws_cond or "").replace("#", "$").split("$"):
        t = " ".join(part.split())
        if t and t.lower() != "no warning" and t.lower() != "no data available":
            out.append(t)
    return out


def window(date: str, toi, vupto):
    """``(issued, valid_until)`` as aware datetimes (Indian time); valid-until after midnight rolls over."""
    day = datetime.fromisoformat(str(date)[:10]).replace(tzinfo=IST)

    def at(hhmm):
        s = f"{int(hhmm):04d}"
        return day + timedelta(hours=int(s[:2]), minutes=int(s[2:]))

    issued, until = at(toi), at(vupto)
    if until < issued:
        until += timedelta(days=1)
    return issued, until


def _perp(p, a, b) -> float:
    (x, y), (x1, y1), (x2, y2) = p, a, b
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
    return abs(dy * x - dx * y + x2 * y1 - y2 * x1) / (dx * dx + dy * dy) ** 0.5


def simplify(points: list, tol: float) -> list:
    """Ramer-Douglas-Peucker on a list of (x, y); the end points are always kept."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        far, idx = 0.0, -1
        for k in range(i + 1, j):
            d = _perp(points[k], points[i], points[j])
            if d > far:
                far, idx = d, k
        if idx != -1 and far > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(points, keep) if k]


def _ring(ring: list) -> list | None:
    pts = [(round(x, ROUND_DP), round(y, ROUND_DP)) for x, y in (c[:2] for c in ring)]
    dedup = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
    s = simplify(dedup, SIMPLIFY_DEG)
    if s[0] != s[-1]:
        s.append(s[0])
    return [list(p) for p in s] if len(s) >= 4 else None  # a closed ring needs 4 positions


def geometry(geom: dict) -> dict | None:
    polys = []
    for poly in geom.get("coordinates") or []:
        rings = [_ring(r) for r in poly]
        if rings and rings[0] is not None:  # drop a polygon whose outer ring collapsed
            polys.append([r for r in rings if r is not None])
    return {"type": "MultiPolygon", "coordinates": polys} if polys else None


def parse(body: bytes) -> list:
    """The FeatureCollection's features; raise ValueError if it is not the expected shape."""
    try:
        d = json.loads(body)
    except ValueError as e:
        raise ValueError(f"response is not JSON: {e}") from e
    feats = d.get("features") if isinstance(d, dict) else None
    if not isinstance(feats, list) or not feats:
        raise ValueError("no features (service changed or empty?)")
    need = {"State_District", "Date", "toi", "vupto", "ws_cond", "color_hex"}
    if not all(
        isinstance(f, dict) and need <= set((f.get("properties") or {})) for f in feats[:20]
    ):
        raise ValueError("features lack the expected fields (service changed?)")
    return feats


def build(feats: list, now: datetime) -> dict:
    """The published FeatureCollection: only districts with a current warning, simplified shapes."""
    out, counts, newest_issue = [], {1: 0, 2: 0, 3: 0}, None
    skipped = 0
    for f in feats:
        p = f["properties"]
        try:
            issued, until = window(p["Date"], p["toi"], p["vupto"])
        except (TypeError, ValueError):
            skipped += 1
            continue
        newest_issue = issued if newest_issue is None or issued > newest_issue else newest_issue
        lvl = level_for(p["color_hex"])
        if lvl is None or until < now or issued > now + timedelta(hours=6):
            continue
        texts = warning_texts(p["ws_cond"])
        geom = geometry(f.get("geometry") or {})
        if geom is None:
            skipped += 1
            continue
        counts[lvl] += 1
        out.append(
            {
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "district": str(p["State_District"]).title(),
                    "level": lvl,
                    "color": p["color_hex"],
                    "warnings": texts,
                    "issued": issued.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "valid_until": until.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                },
            }
        )
    out.sort(key=lambda f: (-f["properties"]["level"], f["properties"]["district"]))
    stale = newest_issue is None or now - newest_issue > timedelta(hours=STALE_AFTER_H)
    return {
        "type": "FeatureCollection",
        "generated": now_iso(),
        "source": "IMD district nowcast (public map service, unofficial access)",
        "attribution": ATTRIBUTION,
        "licence": LICENCE,
        "newest_issue": None
        if newest_issue is None
        else newest_issue.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stale": stale,
        "counts": {"light": counts[1], "moderate": counts[2], "severe": counts[3]},
        "districts_in_service": len(feats),
        "skipped": skipped,
        "note": (
            "Colours are IMD's: amber light, orange moderate, red severe. A nowcast is issued about every "
            "3 hours and is valid for about 3 hours. Only districts with a current warning are drawn."
        ),
        "features": out,
    }


def main(argv=None, fetch=None, now=None) -> int:
    ap = argparse.ArgumentParser(prog="ingest-nowcast", description=__doc__)
    ap.add_argument(
        "--out",
        default=os.environ.get("PUBLIC_DATA_DIR", "public-data"),
        help="public-data directory",
    )
    ap.add_argument("--upload", action="store_true", help="upload to R2 (needs R2_* env vars)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        body = (fetch or (lambda: http_get(URL, timeout=60)))()
        fc = build(parse(body), now or datetime.now(timezone.utc))
    except Exception as exc:  # noqa: BLE001 - leave the previous file in place
        log.error("nowcast failed, previous file untouched: %s", exc)
        return 1
    path = Path(a.out) / "nowcast" / "latest.geojson"
    data = json.dumps(fc, separators=(",", ":"), allow_nan=False).encode()
    atomic_write_bytes(path, data)
    log.info(
        "nowcast: %d warned districts of %d (%s), %.0f kB (%.0f kB gzip)%s",
        len(fc["features"]),
        fc["districts_in_service"],
        fc["counts"],
        len(data) / 1e3,
        gz_size(path) / 1e3,
        " STALE" if fc["stale"] else "",
    )
    if a.upload:
        from .upload import upload_files

        log.info("uploaded %d objects", len(upload_files(Path(a.out), ["nowcast/latest.geojson"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
