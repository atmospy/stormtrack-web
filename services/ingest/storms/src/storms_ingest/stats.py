"""Climatology / analysis -> ``storms/stats/<basin>.json`` using ``stormtrack.analysis``."""

from __future__ import annotations

import pandas as pd
from stormtrack import analysis as A

from .basins import AGENCY_NOTES, BASINS
from .common import now_iso, num

TOP_LIFETIME_MAX = 100
MONTHLY_FROM_YEAR = 1980  # first full satellite-era season used for the monthly climatology


def _wind_mix(obs: pd.DataFrame) -> str:
    """Share of wind values from the WMO agency vs the US (JTWC/NHC) record, when known."""
    if "wind_agency" not in obs.columns:
        return ""
    w = obs.loc[obs["wind"].notna(), "wind_agency"].astype(str)
    if not len(w):
        return ""
    wmo, usa = (w == "wmo").mean() * 100, (w == "usa").mean() * 100
    return (
        f"Of all fixes carrying a wind, {wmo:.0f}% use the basin's WMO agency value and "
        f"{usa:.0f}% are filled from the US (JTWC/NHC, 1-minute) record. "
    )


def build_notes(obs, basin, y0, y1, wind_year, agency_note="") -> str:
    name = BASINS.get(basin, basin)
    prov = ""
    if "track_type" in obs.columns:
        last = obs[obs["year"] == y1]["track_type"].astype(str)
        if last.str.contains("PROVISIONAL").any():
            prov = " Some of its storms are still IBTrACS 'US-PROVISIONAL' (unreviewed JTWC/NHC winds)."
    if basin in ("SI", "SP", "SA"):
        prov += (
            " Southern-Hemisphere seasons run July-June and IBTrACS labels them by the year they end "
            "(a November 2026 storm belongs to season 2027), so `year` is the season, not the calendar year."
        )
    return (
        f"{name} ({basin}): IBTrACS seasons {y0}-{y1}, storms assigned to the basin where they formed, "
        "computed with stormtrack.analysis. `storms` counts every tracked system including "
        "depressions and disturbances; tropical_storm/hurricane/major are plain thresholds on the "
        "lifetime-maximum wind (>= 34 / 64 / 96 kt). The Saffir-Simpson scale is defined for "
        "1-minute winds but is applied here to whatever `wind` the record carries, with no "
        "conversion, so categories (and these counts) in basins reporting 10-minute or 3-minute "
        "winds are systematically lower than the same storm would get from a 1-minute record. "
        "Wind averaging differs between agencies: IMD 3-minute; NHC and JTWC 1-minute; JMA, BoM, "
        "Meteo-France and Fiji 10-minute; WMO gives no conversion for 3-minute winds, so counts, ACE "
        "and rapid-intensification rates are not directly comparable across basins. "
        + AGENCY_NOTES.get(basin, "")
        + " "
        + _wind_mix(obs)
        + (agency_note + " " if agency_note else "")
        + f"Wind is recorded for almost no fixes before {wind_year} (first season with wind on >= 25% of "
        "fixes in this basin; intensity is mostly missing before about 1980 in several basins): earlier storms "
        "count in `storms` but cannot reach any strength class and have zero ACE, so trends over the "
        "full record reflect observing practice, not climate. "
        f"The latest season ({y1}) is provisional: IBTrACS lags the agencies' final best tracks, "
        f"so its counts and intensities can be incomplete.{prov} "
        f"Monthly climatology uses {MONTHLY_FROM_YEAR}-{y1} only (storms per year by month of genesis; "
        "the incomplete latest year counts as a full season). "
        "ACE = 1e-4 * sum(v^2) over 6-hourly fixes with wind >= 34 kt (10^4 kt^2). "
        f"Rapid intensification: >= 30 kt gain in 24 h (Kaplan & DeMaria 2003); lifetime_max lists "
        f"the top {TOP_LIFETIME_MAX} storms by peak wind."
    )


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

    mc = A.monthly_climatology(obs, since=MONTHLY_FROM_YEAR)
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

    lm = (
        A.lifetime_max(obs)
        .dropna(subset=["lmi_wind"])
        .sort_values(["lmi_wind", "year"], ascending=[False, False])
    )
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
    notes = build_notes(obs, basin, y0, y1, wind_year, agency_note)
    return {
        "schema": 1,
        "basin": basin,
        "name": BASINS.get(basin, basin),
        "generated": now_iso(),
        "monthly_period": [MONTHLY_FROM_YEAR, y1],
        "annual": annual,
        "monthly": monthly,
        "rapid_intensification": ri_events,
        "lifetime_max": lifetime,
        "notes": notes,
    }
