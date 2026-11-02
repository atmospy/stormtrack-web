"""JTWC forecasts from the official warning text (WTPN/WTIO/WTPS ``...web.txt``).

JTWC's machine-readable ``.fst`` mirrors are often unreachable, but the warning text on
metoc.navy.mil is public and lists the warning position plus 12-96 h forecast positions
and one-minute winds. We read only those lines. JTWC publishes no cone of uncertainty.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

import pandas as pd

URL = "https://www.metoc.navy.mil/jtwc/products/{name}web.txt"
_PREFIX = {"WP": "wp", "IO": "io", "SH": "sh"}

_POS = re.compile(
    r"(\d{2})(\d{2})(\d{2})Z\s*---\s*(?:NEAR\s+)?(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])"
)
_FC = re.compile(r"^\s*(\d+)\s+HRS,\s+VALID AT:", re.M)
_WIND = re.compile(r"MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT")
_HDR = re.compile(r"^(WT[A-Z]{2}\d{2}) PGTW (\d{2})(\d{2})(\d{2})", re.M)


def text_name(storm_id: str) -> Optional[str]:
    """``WP302026`` -> ``wp3026`` (basin, storm number, 2-digit year); None for other basins."""
    m = re.fullmatch(r"([A-Z]{2})(\d{2})(\d{4})", storm_id)
    if not m or m.group(1) not in _PREFIX:
        return None
    return f"{_PREFIX[m.group(1)]}{m.group(2)}{m.group(3)[2:]}"


def _stamp(dd: int, hh: int, mm: int, ref: datetime) -> datetime:
    """The datetime with this day-of-month/time nearest ``ref`` (handles month rollover)."""
    best = None
    for off in (-1, 0, 1):
        month = ref.month + off
        year = ref.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        try:
            c = datetime(year, month, dd, hh, mm, tzinfo=timezone.utc)
        except ValueError:
            continue
        if best is None or abs(c - ref) < abs(best - ref):
            best = c
    if best is None:
        raise ValueError(f"bad day {dd}")
    return best


def _latlon(m: re.Match) -> tuple:
    lat = float(m.group(4)) * (1 if m.group(5) == "N" else -1)
    lon = float(m.group(6)) * (1 if m.group(7) == "E" else -1)
    return lat, lon


def parse_warning(text: str, now: Optional[datetime] = None) -> pd.DataFrame:
    """Forecast table (``init, tau, lat, lon, vmax, tech``) from one warning message.

    ``tau`` 0 is the warning position; later rows are the forecasts. Raises ValueError
    when the text has no recognisable warning position.
    """
    now = now or datetime.now(timezone.utc)
    h = _HDR.search(text)
    if not h:
        raise ValueError("not a JTWC warning message")
    issued = _stamp(int(h.group(2)), int(h.group(3)), int(h.group(4)), now)
    body = text.split("WARNING POSITION:", 1)
    if len(body) != 2:
        raise ValueError("no WARNING POSITION block")
    after = body[1]
    p0 = _POS.search(after)
    if not p0:
        raise ValueError("no warning position")
    init = _stamp(int(p0.group(1)), int(p0.group(2)), int(p0.group(3)), issued)
    if init > issued:  # position time is never after the issue time
        init = _stamp(
            int(p0.group(1)), int(p0.group(2)), int(p0.group(3)), issued - timedelta(days=15)
        )
    rows = []
    lat, lon = _latlon(p0)
    w0 = _WIND.search(after, p0.end())
    rows.append((init, 0, lat, lon, float(w0.group(1)) if w0 else None))
    fc = after.split("FORECASTS:", 1)
    if len(fc) == 2:
        blocks = list(_FC.finditer(fc[1]))
        for i, b in enumerate(blocks):
            end = blocks[i + 1].start() if i + 1 < len(blocks) else len(fc[1])
            chunk = fc[1][b.end() : end]
            p = _POS.search(chunk)
            if not p:
                continue
            la, lo = _latlon(p)
            w = _WIND.search(chunk)
            rows.append((init, int(b.group(1)), la, lo, float(w.group(1)) if w else None))
    df = pd.DataFrame(rows, columns=["init", "tau", "lat", "lon", "vmax"])
    df["init"] = pd.to_datetime(df["init"], utc=True).dt.tz_localize(None)
    df["tech"] = "JTWC"
    return df.sort_values("tau").reset_index(drop=True)


def fetch_forecast(
    storm_id: str, get: Callable[[str], str], now: Optional[datetime] = None
) -> pd.DataFrame:
    name = text_name(storm_id)
    if name is None:
        raise ValueError(f"no JTWC warning text for {storm_id}")
    return parse_warning(get(URL.format(name=name)), now)
