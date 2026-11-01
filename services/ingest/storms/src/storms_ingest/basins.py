"""IBTrACS basin metadata and the per-basin loader (CONTRACTS section 2, Round 2)."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

# Display order for the UI. Names follow IBTrACS genesis-basin codes.
BASINS = {
    "NA": "North Atlantic",
    "EP": "East Pacific",
    "WP": "West Pacific",
    "NI": "North Indian",
    "SI": "South Indian",
    "SP": "South Pacific",
    "SA": "South Atlantic",
}

# What each basin's IBTrACS `wind` really is (wmo_wind first, USA/JTWC filling the gaps).
AGENCY_NOTES = {
    "NA": "North Atlantic winds come from NHC (1-minute sustained).",
    "EP": "East Pacific (incl. Central Pacific) winds come from NHC/CPHC (1-minute sustained).",
    "WP": (
        "West Pacific winds are JMA's 10-minute sustained winds where JMA reports them and "
        "JTWC's 1-minute winds otherwise, so 'wind' mixes two averaging periods "
        "(1-minute winds are typically around 10% higher than 10-minute ones)."
    ),
    "NI": (
        "North Indian winds are IMD's 3-minute sustained winds where IMD reports them and "
        "JTWC's 1-minute winds otherwise."
    ),
    "SI": (
        "South Indian winds are 10-minute sustained winds from Meteo-France La Reunion / BoM "
        "(Mauritius, Madagascar services) where reported and JTWC's 1-minute winds otherwise."
    ),
    "SP": (
        "South Pacific winds are 10-minute sustained winds from BoM / Fiji Meteorological Service / "
        "NZ MetService where reported and JTWC's 1-minute winds otherwise."
    ),
    "SA": (
        "South Atlantic has no WMO-designated agency in IBTrACS; winds are mostly JTWC/NHC 1-minute "
        "values, and the basin has very few storms."
    ),
}


def basin_list(spec: str) -> list:
    """Parse ``--basin``: ``all`` or a comma-separated list of codes, in display order."""
    s = [x.strip().upper() for x in spec.split(",") if x.strip()]
    if not s or "ALL" in s:
        return list(BASINS)
    bad = [x for x in s if x not in BASINS]
    if bad:
        raise ValueError(f"unknown basin(s) {bad}; expected ALL or any of {list(BASINS)}")
    return [b for b in BASINS if b in s]


def load_basin(basin: str, cache_dir: Optional[Path] = None):
    """Return ``(observations, storms, sources)`` for one genesis basin.

    NI uses the library's pre-parsed IMD+IBTrACS dataset (fast, no download). Every other
    basin downloads that basin's NCEI CSV once (see README for sizes) into ``cache_dir`` and
    reuses it on later runs.
    """
    import stormtrack as st

    if basin == "NI":
        bt = st.load_ibtracs()
        return bt.observations, bt.storms, ["IMD", "IBTrACS"]
    bt = st.load_ibtracs(basin=basin, source="ncei", cache_dir=cache_dir)
    return bt.observations, bt.storms, ["IBTrACS"]
