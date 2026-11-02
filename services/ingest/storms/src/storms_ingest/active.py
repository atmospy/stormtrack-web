"""Active systems -> ``storms/active.geojson`` (CONTRACTS section 2)."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Optional

import pandas as pd
import stormtrack as st
from stormtrack.analysis import translation_speed

from .common import cat_obj, category, iso, line_geometry, now_iso, num, split_antimeridian
from .cone import cone_geometry
from .jtwc_text import fetch_forecast as fetch_jtwc_text

log = logging.getLogger(__name__)

AGENCY = {"nhc": "NHC", "jtwc": "JTWC"}

# JTWC publishes no cone. When we draw one for a JTWC storm it uses NHC-derived radii and must say so.
PROXY_NOTE = (
    "PROXY, not a JTWC product: JTWC publishes no cone of uncertainty. Radii are our estimate from NHC "
    "(Atlantic/East Pacific) track errors, so they likely understate the western North Pacific / Indian "
    "Ocean error; treat as indicative only. "
)


def _http_text(url: str, timeout: float = 20.0) -> str:
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "stormtrack-web-ingest"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - fixed https host
        return r.read().decode("latin-1")


def _get_forecast(sid: str, src: str, timeout: float = 20.0) -> pd.DataFrame:
    """Agency forecast: JTWC from its warning text first, then the library (ATCF mirrors)."""
    if src == "jtwc":
        try:
            return fetch_jtwc_text(sid, lambda u: _http_text(u, timeout))
        except Exception as exc:  # noqa: BLE001
            log.info(
                "JTWC warning text unavailable for %s (%s); trying ATCF mirrors",
                sid,
                str(exc)[:120],
            )
    return st.realtime.get_forecast(sid, source=src, timeout=timeout)


def contract_basin(basin: str, lon: float) -> str:
    """Map stormtrack's basin code to the contract's IBTrACS codes (SH -> SI/SP at 135E)."""
    if basin == "SH":
        return "SI" if (lon % 360) < 135 else "SP"
    return basin


def _list(series) -> list:
    return [num(v) for v in series]


LATE_WARNING = pd.Timedelta(minutes=30)


def latest_warning_fix(obs: pd.DataFrame, fc: Optional[pd.DataFrame]) -> pd.DataFrame:
    """Append the warning's own position (forecast lead time 0) when it is newer than the last best-track fix.

    The best-track file lags the live warning by several hours, so without this the marker and the end of the
    observed track sit at an old position while the forecast already starts somewhere else.
    """
    if fc is None or fc.empty or "tau" not in fc or "init" not in fc:
        return obs
    now_fix = fc[fc["tau"] == 0]
    if now_fix.empty:
        return obs
    r = now_fix.sort_values("init").iloc[-1]
    if pd.isna(r["lat"]) or pd.isna(r["lon"]) or pd.isna(r["init"]):
        return obs
    last = obs.iloc[-1]
    if pd.Timestamp(r["init"]) <= pd.Timestamp(last["time"]) + LATE_WARNING:
        return obs
    row = last.copy()
    row["time"] = pd.Timestamp(r["init"])
    row["lat"], row["lon"] = float(r["lat"]), float(r["lon"])
    if "vmax" in r and not pd.isna(r["vmax"]):
        row["wind"] = float(r["vmax"])
    if "pressure" in row.index:
        row["pressure"] = float("nan")  # the warning gives no central pressure
    return pd.concat([obs, row.to_frame().T], ignore_index=True).astype(
        obs.dtypes.to_dict(), errors="ignore"
    )


def position_feature(obs: pd.DataFrame, agency: str) -> dict:
    """Point feature for the latest fix of one storm (obs sorted by time)."""
    ts = translation_speed(obs).sort_values("time")
    last = ts.iloc[-1]
    wind = num(last["wind"])
    return {
        "type": "Feature",
        "geometry": {
            "type": "Point",
            "coordinates": [round(float(last["lon"]), 3), round(float(last["lat"]), 3)],
        },
        "properties": {
            "kind": "position",
            "id": str(last["storm_id"]),
            "name": None if pd.isna(last["name"]) else str(last["name"]),
            "basin": contract_basin(str(last["basin"]), float(last["lon"])),
            "agency": agency,
            "time": iso(last["time"]),
            "wind_kt": wind,
            "wind_period_min": 1,
            "pressure_hpa": num(last["pressure"]),
            "category": cat_obj(wind),
            "heading_deg": num(last["heading"], 0),
            "speed_kmh": num(last["speed_kmh"], 1),
        },
    }


def track_feature(obs: pd.DataFrame) -> Optional[dict]:
    obs = obs.sort_values("time")
    if len(obs) < 2:
        return None
    times = [iso(t) for t in obs["time"]]
    wind = _list(obs["wind"])
    parts, vals = split_antimeridian(
        list(obs["lon"]), list(obs["lat"]), {"times": times, "wind_kt": wind}
    )
    geom = line_geometry(parts)
    return {
        "type": "Feature",
        "geometry": geom,
        "properties": {
            "kind": "track",
            "id": str(obs["storm_id"].iloc[0]),
            "times": vals["times"],
            "wind_kt": [None if v is None else num(v, 1) for v in vals["wind_kt"]],
        },
    }


def forecast_features(
    storm_id: str, fc: pd.DataFrame, radii: Optional[dict], proxy: bool = False
) -> list:
    """Forecast LineString (+ cone when radii are available) for one storm."""
    fc = fc.sort_values(["init", "tau"])
    fc = fc[fc["init"] == fc["init"].max()].drop_duplicates("tau").sort_values("tau")
    if len(fc) < 2:
        return []
    taus = [int(t) for t in fc["tau"]]
    wind = _list(fc["vmax"])
    # one entry per vertex; crossing vertices (antimeridian) get interpolated tau/wind
    parts, vals = split_antimeridian(
        list(fc["lon"]), list(fc["lat"]), {"taus": taus, "wind_kt": wind}
    )
    vtaus = [None if v is None else int(round(v)) for v in vals["taus"]]
    vwind = [None if v is None else num(v, 0) for v in vals["wind_kt"]]
    feats = [
        {
            "type": "Feature",
            "geometry": line_geometry(parts),
            "properties": {
                "kind": "forecast",
                "id": storm_id,
                "init": iso(fc["init"].iloc[0]),
                "tech": str(fc["tech"].iloc[0]),
                "taus": vtaus,
                "wind_kt": vwind,
                "category": [category(w) for w in vwind],
            },
        }
    ]
    if radii and radii.get("radii_km"):
        geom = cone_geometry(fc, radii["radii_km"])
        if geom is not None:
            used = sorted(t for t in radii["radii_km"] if t <= max(taus))
            feats.append(
                {
                    "type": "Feature",
                    "geometry": geom,
                    "properties": {
                        "kind": "cone",
                        "id": storm_id,
                        "taus": used,
                        "radii_km": [round(radii["radii_km"][t], 1) for t in used],
                        "basis": (PROXY_NOTE if proxy else "") + radii["basis"],
                        **({"proxy": True} if proxy else {}),
                    },
                }
            )
    return feats


def fetch_active(source: str, timeout: float = 60.0):
    return st.realtime.active_storms(source, timeout=timeout)


def build_active(
    radii: Optional[dict],
    sources=("nhc", "jtwc"),
    fetch_active_fn: Callable = fetch_active,
    fetch_forecast_fn: Callable = None,
    timeout: float = 60.0,
):
    """Query all agencies (concurrently) and build the FeatureCollection.

    Returns ``(collection, report)``; ``report`` has per-source status, the storms found
    and which forecasts were unavailable. A failing source is recorded, not raised.
    """
    fetch_forecast_fn = fetch_forecast_fn or _get_forecast
    report = {"ok": [], "failed": {}, "storms": [], "forecast_unavailable": [], "forecast_ok": []}

    def run(src):
        try:
            return src, fetch_active_fn(src, timeout), None
        except Exception as exc:  # noqa: BLE001
            return src, None, exc

    with ThreadPoolExecutor(len(sources)) as ex:
        results = list(ex.map(run, sources))

    features: list = []
    for src, bt, exc in results:
        if exc is not None:
            log.warning("active source %s failed: %s", src, exc)
            report["failed"][src] = f"{type(exc).__name__}: {exc}"
            continue
        report["ok"].append(src)
        obs = bt.observations
        for sid, o in obs.groupby("storm_id", sort=True):
            o = o.sort_values("time")
            # the forecast first: a warning can be newer than the best-track file, and then its position is
            # the storm's latest fix (marker and track end must be where the forecast starts)
            fc, fc_err = None, None
            try:
                fc = fetch_forecast_fn(sid, src)
            except Exception as exc2:  # noqa: BLE001 - JTWC forecast mirrors are often blocked
                fc_err = exc2
            o = latest_warning_fix(o, fc)
            features.append(position_feature(o, AGENCY[src]))
            tr = track_feature(o)
            if tr:
                features.append(tr)
            report["storms"].append(
                {
                    "id": sid,
                    "name": None if pd.isna(o["name"].iloc[-1]) else o["name"].iloc[-1],
                    "agency": AGENCY[src],
                }
            )
            if fc is None:
                log.info("no forecast for %s: %s", sid, str(fc_err)[:200])
                report["forecast_unavailable"].append(sid)
                continue
            try:
                fcf = forecast_features(sid, fc, radii, proxy=(src == "jtwc"))
            except Exception as exc3:  # noqa: BLE001
                log.info("forecast for %s unusable: %s", sid, str(exc3)[:200])
                fcf = []
            features += fcf
            report["forecast_ok" if fcf else "forecast_unavailable"].append(sid)
    order = {"position": 0, "track": 1, "forecast": 2, "cone": 3}
    features.sort(key=lambda f: (f["properties"]["id"], order[f["properties"]["kind"]]))
    fc_ = {
        "type": "FeatureCollection",
        "generated": now_iso(),
        "sources": [AGENCY[s] for s in report["ok"]],
        "features": features,
    }
    return fc_, report
