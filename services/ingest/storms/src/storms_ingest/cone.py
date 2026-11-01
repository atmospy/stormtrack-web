"""Forecast-cone radii (our own estimate) and cone geometry.

NHC's published cone is built from circles whose radii contain 67 % of the previous
five years of official-forecast track errors. We cannot reproduce NHC's exact numbers,
so we estimate radii the same way from a recent sample: the OFCL a-decks of the last
``years`` completed seasons (AL, EP, CP) scored against their NHC best tracks with
``stormtrack.verification``. Radii are therefore *our estimate*, not NHC's.
"""

from __future__ import annotations

import gzip
import logging
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.ops import unary_union
from shapely.affinity import translate
from shapely.geometry.polygon import orient

import stormtrack as st
from stormtrack import verification as V
from stormtrack.atcf import best_track_frame, parse_atcf

log = logging.getLogger(__name__)

NHC_ARCHIVE = "https://ftp.nhc.noaa.gov/atcf/archive/{year}/"
_UA = {"User-Agent": "stormtrack-web-ingest (https://github.com/atmospy/stormtrack-web)"}
MIN_N = 30  # minimum number of scored forecasts per lead time to publish a radius
DEFAULT_YEARS = 2


def _get(url: str, timeout: float = 120.0, retries: int = 3) -> bytes:
    """GET with retries (the NHC server truncates long transfers under load)."""
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=_UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
                data = r.read()
            return gzip.decompress(data) if url.endswith(".gz") else data
        except Exception as exc:  # noqa: BLE001 - IncompleteRead, timeouts, resets
            last = exc
            time.sleep(2 * (i + 1))
    raise last


def list_season_storms(year: int, timeout: float = 60.0, fetch=None) -> list:
    """(basin, cy) of every numbered AL/EP/CP storm with an archived a-deck + b-deck."""
    html = (fetch or _get)(NHC_ARCHIVE.format(year=year), timeout).decode("utf-8", "replace")
    a = set(re.findall(rf'href="a(al|ep|cp)(\d\d){year}\.dat\.gz"', html))
    b = set(re.findall(rf'href="b(al|ep|cp)(\d\d){year}\.dat\.gz"', html))
    return sorted((bs, cy) for bs, cy in a & b if int(cy) < 90)


_COLS = ["atcf_id", "init", "tau", "track_err_km"]


def score_storm(year: int, basin: str, cy: str, fetch=_get, cache_dir: Optional[Path] = None) -> Optional[pd.DataFrame]:
    """OFCL track errors for one archived storm.

    Cached per storm (a finished storm's archive never changes), so an interrupted run
    resumes. Returns ``None`` when the download failed (not cached, will be retried next
    run); an empty frame means the storm genuinely has nothing to score.
    """
    cache = Path(cache_dir) / f"{year}" / f"{basin}{cy}.parquet" if cache_dir else None
    if cache is not None and cache.exists():
        return pd.read_parquet(cache)
    base = NHC_ARCHIVE.format(year=year)
    try:
        deck = parse_atcf(fetch(f"{base}a{basin}{cy}{year}.dat.gz"))
        deck = deck[deck["tech"] == "OFCL"].reset_index(drop=True)
        best = best_track_frame(parse_atcf(fetch(f"{base}b{basin}{cy}{year}.dat.gz")))
    except Exception as exc:  # noqa: BLE001 - one bad file must not sink the sample
        log.warning("skip %s%s%s: %s", basin, cy, year, exc)
        return None
    out = pd.DataFrame(columns=_COLS)
    if not deck.empty and not best.empty:
        err = V.forecast_errors(deck, best)
        if len(err):
            out = err[_COLS].reset_index(drop=True)
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        out.to_parquet(cache)
    return out


def season_errors(year: int, cache_dir: Optional[Path], fetch=_get, workers: int = 4) -> pd.DataFrame:
    """OFCL errors for a completed season (storms that failed to download are skipped
    this run and retried on the next one)."""
    storms = list_season_storms(year, fetch=fetch)
    with ThreadPoolExecutor(workers) as ex:
        parts = list(ex.map(lambda s: score_storm(year, s[0], s[1], fetch, cache_dir), storms))
    n_fail = sum(p is None for p in parts)
    if n_fail:
        log.warning("season %s: %d of %d storms could not be downloaded", year, n_fail, len(storms))
    parts = [p for p in parts if p is not None and len(p)]
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=_COLS)


def estimate_radii(errors: pd.DataFrame, years: list, pct: float = 67.0, min_n: int = MIN_N) -> dict:
    """Radii (km) by lead time + provenance from a pooled error sample."""
    errors = errors[errors["tau"] > 0] if len(errors) else errors
    r = V.error_radii(errors, pct=pct, min_n=min_n, units="km") if len(errors) else pd.Series(dtype=float)
    n_by_tau = errors.groupby("tau").size() if len(errors) else pd.Series(dtype=int)
    if r.empty:
        basis = (
            f"No cone: only {len(errors)} scored OFCL forecasts from the {years} seasons "
            f"(need >= {min_n} per lead time). Radii are our own estimate, not NHC's."
        )
    else:
        n_storms = errors["atcf_id"].nunique()
        basis = (
            f"Our estimate, not NHC's published cone: {pct:g}th percentile of NHC official (OFCL) "
            f"track errors, {len(errors)} scored forecast points from {n_storms} Atlantic/East/"
            f"Central Pacific storms in the {', '.join(map(str, sorted(years)))} seasons "
            f"(>= {min_n} per lead time; lead times {int(r.index.min())}-{int(r.index.max())} h). "
            "Circles of these radii swept along the forecast track; track error only."
        )
    return {
        "radii_km": {int(t): float(v) for t, v in r.items()},
        "n": {int(t): int(n_by_tau.get(t, 0)) for t in r.index},
        "n_errors": int(len(errors)),
        "years": list(years),
        "basis": basis,
    }


def build_radii(cache_dir: Optional[Path], years_back: int = DEFAULT_YEARS, now_year: Optional[int] = None,
                fetch=_get) -> dict:
    """Pool the last ``years_back`` completed seasons' OFCL errors into cone radii."""
    now_year = now_year or pd.Timestamp.utcnow().year
    years = [now_year - k for k in range(1, years_back + 1)]
    frames = []
    for y in years:
        try:
            frames.append(season_errors(y, cache_dir, fetch))
        except Exception as exc:  # noqa: BLE001
            log.warning("could not score season %s: %s", y, exc)
    errors = pd.concat([f for f in frames if len(f)], ignore_index=True) if any(len(f) for f in frames) else pd.DataFrame()
    return estimate_radii(errors, years)


# --- geometry ----------------------------------------------------------------


def _wrap_polygon(geom) -> list:
    """Wrap a polygon in a locally-unwrapped longitude frame back into [-180, 180]."""
    pieces = []
    world = box(-180, -90, 180, 90)
    for shift in (-720, -360, 0, 360, 720):
        part = translate(geom, xoff=shift).intersection(world)
        if part.is_empty:
            continue
        pieces += [part] if isinstance(part, Polygon) else [g for g in getattr(part, "geoms", []) if isinstance(g, Polygon)]
    return pieces


def cone_geometry(forecast: pd.DataFrame, radii_km: dict) -> Optional[dict]:
    """GeoJSON Polygon/MultiPolygon of the cone, or None if it cannot be built.

    The segment hulls from ``stormtrack.verification.cone_polygons`` are unioned (so the
    geometry is valid), clipped to the map and split at the antimeridian when needed.
    """
    if not radii_km:
        return None
    polys = V.cone_polygons(forecast, pd.Series(radii_km))
    if not polys:
        return None
    lat_lim = 89.5
    shapes = []
    for p in polys:
        if len(p) < 3:
            continue
        shp = Polygon(p)
        shapes.append(shp if shp.is_valid else shp.buffer(0))
    if not shapes:
        return None
    union = unary_union(shapes).simplify(0.01)
    union = union.intersection(box(-1e4, -lat_lim, 1e4, lat_lim))
    members = [union] if isinstance(union, Polygon) else list(getattr(union, "geoms", []))
    out = []
    for m in members:
        if isinstance(m, Polygon) and not m.is_empty:
            out += _wrap_polygon(m)
    if not out:
        return None

    def ring(r):
        return [[round(x, 3), round(y, 3)] for x, y in r.coords]

    def coords(p):
        p = orient(Polygon(p.exterior, p.interiors), 1.0)
        return [ring(p.exterior)] + [ring(i) for i in p.interiors]

    if len(out) == 1:
        return {"type": "Polygon", "coordinates": coords(out[0])}
    return {"type": "MultiPolygon", "coordinates": [coords(p) for p in out]}
