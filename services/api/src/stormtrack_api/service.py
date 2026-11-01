"""Data access + computation (kept separate from HTTP so it is easy to test/fake)."""

from __future__ import annotations

import threading
import time
from typing import Callable, Optional

import numpy as np
import pandas as pd

SS = [("TD", 0), ("TS", 34), ("C1", 64), ("C2", 83), ("C3", 96), ("C4", 113), ("C5", 137)]


def category(w) -> Optional[str]:
    if w is None or (isinstance(w, float) and np.isnan(w)):
        return None
    lab = "TD"
    for name, lo in SS:
        if w >= lo:
            lab = name
    return lab


class TTLCache:
    """Tiny thread-safe in-memory cache with per-key expiry."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._d: dict = {}
        self._lock = threading.Lock()
        self._clock = clock

    def get_or_set(self, key, ttl: float, fn: Callable):
        now = self._clock()
        with self._lock:
            hit = self._d.get(key)
            if hit and hit[0] > now:
                return hit[1]
        value = fn()
        with self._lock:
            self._d[key] = (now + ttl, value)
        return value


def _iso(t) -> Optional[str]:
    return None if pd.isna(t) else pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")


def _f(x, nd=1):
    return None if x is None or pd.isna(x) else round(float(x), nd)


def active_geojson(fetch_active: Callable) -> dict:
    """Points + tracks for active systems (no forecasts: those are the static job's)."""
    feats, sources, failed = [], [], {}
    for src, agency in (("nhc", "NHC"), ("jtwc", "JTWC")):
        try:
            bt = fetch_active(src)
        except Exception as exc:  # noqa: BLE001
            failed[agency] = f"{type(exc).__name__}"
            continue
        sources.append(agency)
        for sid, o in bt.observations.groupby("storm_id"):
            o = o.sort_values("time")
            last = o.iloc[-1]
            w = _f(last["wind"], 0)
            feats.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [round(float(last["lon"]), 3), round(float(last["lat"]), 3)],
                    },
                    "properties": {
                        "kind": "position",
                        "id": sid,
                        "name": None if pd.isna(last["name"]) else str(last["name"]),
                        "agency": agency,
                        "time": _iso(last["time"]),
                        "wind_kt": w,
                        "wind_period_min": 1,
                        "pressure_hpa": _f(last["pressure"], 0),
                        "category": None
                        if w is None
                        else {"scale": "saffir-simpson", "label": category(w)},
                    },
                }
            )
    return {"type": "FeatureCollection", "sources": sources, "failed": failed, "features": feats}


def summarize(
    obs: pd.DataFrame, storm_id: str, wind_period_min: Optional[int], source: str
) -> dict:
    """Lifetime summary of one storm using stormtrack.analysis."""
    from stormtrack import analysis as A

    o = obs[obs["storm_id"] == storm_id].sort_values("time")
    lm = A.lifetime_max(o).iloc[0]
    ace = A.ace(o)
    ri = A.rapid_intensification(o)
    peak = _f(lm["lmi_wind"], 0)
    return {
        "id": storm_id,
        "name": None if pd.isna(lm["name"]) else str(lm["name"]),
        "source": source,
        "wind_period_min": wind_period_min,
        "year": int(lm["year"]),
        "start": _iso(lm["start_time"]),
        "end": _iso(lm["end_time"]),
        "duration_days": _f(lm["duration_days"], 2),
        "n_fixes": int(len(o)),
        "peak": {
            "wind_kt": peak,
            "category": category(peak),
            "time": _iso(lm["lmi_time"]),
            "lat": _f(lm["lmi_lat"], 2),
            "lon": _f(lm["lmi_lon"], 2),
        },
        "min_pressure_hpa": _f(lm["min_pressure"], 0),
        "genesis": {"lat": _f(lm["genesis_lat"], 2), "lon": _f(lm["genesis_lon"], 2)},
        "ace": round(float(ace["ace"].sum()), 2) if len(ace) else 0.0,
        "max_dwind_kt_24h": _f(ri["max_dwind"].iloc[0], 0) if len(ri) else None,
        "rapid_intensification": bool(ri["rapid"].iloc[0]) if len(ri) else False,
        "caveat": (
            "1-minute sustained wind (NHC/JTWC)."
            if wind_period_min == 1
            else "IBTrACS merged wind: IMD 3-minute where available, else JTWC 1-minute; "
            "not directly comparable across agencies."
        ),
    }
