"""Locate a complete GFS run and fetch only the 10 m U/V GRIB2 records."""

from __future__ import annotations

import datetime as dt
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional, Tuple

from . import http

log = logging.getLogger("stormtrack.wind")
BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
CYCLES = (0, 6, 12, 18)
WANT = ("UGRD:10 m above ground", "VGRD:10 m above ground")


def base_url(run: dt.datetime, fhr: int) -> str:
    return f"{BUCKET}/gfs.{run:%Y%m%d}/{run:%H}/atmos/gfs.t{run:%H}z.pgrb2.0p25.f{fhr:03d}"


def run_id(run: dt.datetime) -> str:
    return f"{run:%Y%m%dT%H}"


def run_id_from_iso(iso: str) -> str:
    """'2026-11-01T12:00:00Z' -> '20261101T12'."""
    return f"{iso[0:4]}{iso[5:7]}{iso[8:10]}T{iso[11:13]}"


def parse_run(s: str) -> dt.datetime:
    s = s.strip().replace("-", "").replace("T", "").replace("Z", "")
    r = dt.datetime.strptime(s[:10], "%Y%m%d%H").replace(tzinfo=dt.timezone.utc)
    if r.hour not in CYCLES:
        raise ValueError("run hour must be 00/06/12/18")
    return r


def candidate_runs(now: dt.datetime, n: int = 8) -> List[dt.datetime]:
    """Newest cycle <= now, then going back 6 h at a time."""
    now = now.astimezone(dt.timezone.utc)
    r = now.replace(minute=0, second=0, microsecond=0)
    r -= dt.timedelta(hours=r.hour % 6)
    return [r - dt.timedelta(hours=6 * i) for i in range(n)]


def run_complete(run: dt.datetime, fhrs: List[int], workers: int = 8) -> bool:
    """Every needed forecast hour has its .idx (NOAA writes it after the GRIB)."""
    with ThreadPoolExecutor(workers) as ex:
        # newest/last hour first-ish: check the last one alone to fail fast
        if not http.head(base_url(run, fhrs[-1]) + ".idx"):
            return False
        return all(ex.map(lambda f: http.head(base_url(run, f) + ".idx"), fhrs))


def find_latest_run(now: dt.datetime, fhrs: List[int]) -> dt.datetime:
    for r in candidate_runs(now):
        ok = run_complete(r, fhrs)
        log.info("probe run %s: %s", run_id(r), "complete" if ok else "incomplete/missing")
        if ok:
            return r
    raise RuntimeError("no complete GFS run found in the last 48 h")


def parse_idx(text: str) -> List[Tuple[int, str]]:
    """-> [(byte_offset, 'VAR:level'), ...] in file order."""
    out = []
    for line in text.splitlines():
        p = line.split(":")
        if len(p) >= 5:
            out.append((int(p[1]), f"{p[3]}:{p[4]}"))
    return out


def uv_ranges(idx: List[Tuple[int, str]]) -> List[Tuple[int, Optional[int]]]:
    """Inclusive byte ranges covering the U and V records, merged when adjacent."""
    ranges = []
    for want in WANT:
        for i, (off, key) in enumerate(idx):
            if key == want:
                end = idx[i + 1][0] - 1 if i + 1 < len(idx) else None
                ranges.append((off, end))
                break
        else:
            raise KeyError(f"{want} not in .idx")
    ranges.sort()
    if ranges[0][1] is not None and ranges[0][1] + 1 == ranges[1][0]:
        return [(ranges[0][0], ranges[1][1])]
    return ranges


def fetch_uv(run: dt.datetime, fhr: int) -> bytes:
    """Return concatenated GRIB2 messages (U then V) for one forecast hour."""
    base = base_url(run, fhr)
    idx = parse_idx(http.get(base + ".idx").decode())
    return b"".join(http.get(base, r) for r in uv_ranges(idx))
