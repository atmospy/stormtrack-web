"""Climatology / analysis -> ``storms/stats/<basin>.json`` using ``stormtrack.analysis``."""

from __future__ import annotations

import pandas as pd

from stormtrack import analysis as A

from .common import now_iso, num

TOP_LIFETIME_MAX = 100
MONTHLY_FROM_YEAR = 1980  # first full satellite-era season used for the monthly climatology


def build_stats(obs: pd.DataFrame, basin: str, agency_note: str = "") -> dict:
    ann = A.annual_counts(obs)
    ace = A.ace(obs)
    ace_year = ace.groupby("year")["ace"].sum()
    annual = [
        {
            "year": int(r.year),
            "storms": int(r.storms),
            "tropical_storm": int(r.tropical_storm),
            "hurricane": int(r.hurricane),
            "major": int(r.major),
            "ace": round(float(ace_year.get(r.year, 0.0)), 2),
        }
        for r in ann.itertuples()
    ]

    modern = obs[obs["year"] >= MONTHLY_FROM_YEAR]
    mc = A.monthly_climatology(modern) if len(modern) else pd.DataFrame(columns=["month", "per_year"])
    per = {int(r.month): float(r.per_year) for r in mc.itertuples()}
    monthly = [{"month": m, "storms_per_year": round(per.get(m, 0.0), 3)} for m in range(1, 13)]

    ri = A.rapid_intensification(obs)
    ri = ri[ri["rapid"]].sort_values("max_dwind", ascending=False)
    ri_events = [
        {
            "id": r.storm_id,
            "name": None if pd.isna(r.name) else str(r.name),
            "year": int(r.year),
            "max_dwind_kt_24h": num(r.max_dwind),
        }
        for r in ri.itertuples()
    ]

    lm = A.lifetime_max(obs).dropna(subset=["lmi_wind"]).sort_values(["lmi_wind", "year"], ascending=[False, False])
    lifetime = [
        {
            "id": r.storm_id,
            "name": None if pd.isna(r.name) else str(r.name),
            "year": int(r.year),
            "wind_kt": num(r.lmi_wind),
            "lat": num(r.lmi_lat, 2),
            "lon": num(r.lmi_lon, 2),
        }
        for r in lm.head(TOP_LIFETIME_MAX).itertuples()
    ]

    y0, y1 = int(obs["year"].min()), int(obs["year"].max())
    cov = obs.groupby("year")["wind"].apply(lambda w: w.notna().mean())
    wind_year = int(cov[cov >= 0.25].index.min()) if (cov >= 0.25).any() else y1
    notes = (
        f"Basin {basin}, IBTrACS seasons {y0}-{y1}, computed with stormtrack.analysis. "
        "Strength classes use each storm's lifetime-maximum wind: tropical_storm >= 34 kt, "
        "hurricane >= 64 kt, major >= 96 kt (the field names follow the Atlantic convention; they are wind thresholds, "
        "not IMD grades). "
        "Wind averaging differs between agencies: IMD reports 3-minute sustained winds, JTWC/NHC 1-minute, JMA 10-minute; "
        "WMO gives no conversion for 3-minute winds, so counts and ACE are not directly comparable across agencies or basins. "
        + (agency_note + " " if agency_note else "")
        + f"Wind is recorded for almost no fixes before {wind_year} (first season with wind on >= 25% of fixes here): "
        "earlier storms count in `storms` but cannot reach any strength class and have zero ACE, so trends over the full "
        "record reflect observing practice, not climate. "
        f"The latest season ({y1}) is provisional: IBTrACS lags the agencies' final best tracks, so its counts and "
        "intensities can be incomplete. "
        f"Monthly climatology uses {MONTHLY_FROM_YEAR}-{y1} only (storms per year by month of genesis). "
        "ACE = 1e-4 * sum(v^2) over 6-hourly fixes with wind >= 34 kt (10^4 kt^2). "
        f"Rapid intensification: >= 30 kt gain in 24 h (Kaplan & DeMaria 2003); lifetime_max lists the top {TOP_LIFETIME_MAX} storms by peak wind."
    )
    return {
        "schema": 1,
        "basin": basin,
        "generated": now_iso(),
        "monthly_period": [MONTHLY_FROM_YEAR, y1],
        "annual": annual,
        "monthly": monthly,
        "rapid_intensification": ri_events,
        "lifetime_max": lifetime,
        "notes": notes,
    }
