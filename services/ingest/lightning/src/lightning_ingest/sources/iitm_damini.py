"""IITM Pune "Damini" lightning feed for India (UNOFFICIAL, undocumented, plain HTTP).

``GET http://103.251.184.43/json/india.php`` (host registered to IITM-PUNE, reverse DNS
daminiapp.tropmet.res.in) returns an HTML page (Leaflet map, ~9 kB) that embeds the recent strikes
as an inline JavaScript literal::

    const lightningData = [{"lat":"17.9333","lng":"94.1774","label":"10min"}, ...];

lat/lng are STRINGS with 4 decimals. ``label`` is one of ``5min`` / ``10min`` / ``15min``, an age
bucket. ASSUMPTION (unverified): "within the last 5 min", "5-10 min", "10-15 min". We therefore
place a strike at the bucket midpoint (2.5 / 7.5 / 12.5 min) before OUR fetch time and publish
``time_uncertainty_s = 150``. There is no per-strike time, energy or polarity. The same strike
shows up in successive snapshots as it ages, so new strikes are de-duplicated against the rows
already published for this source (same lon/lat at 4 dp and a time within ~16 min = same strike;
the earlier row is kept). The server's ``Date`` header was seen ~5.5 min ahead of a local clock, so
server time is only recorded (``clock_skew_s``), never used for ordering.

Politeness: one request per poll, at most one retry (after 5 s) on a network error, a 15 s timeout,
a 2 MB response cap, a descriptive User-Agent and an enforced minimum interval between fetches
(default and floor 60 s, kept in the source state; a poll sooner than that makes no request).

This module never raises from ``poll``: a changed or missing page yields a Batch with an error
and no strikes.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
import zlib
from email.utils import parsedate_to_datetime

import numpy as np

from . import Batch

URL = "http://103.251.184.43/json/india.php"
USER_AGENT = "stormtrack-web-ingest (+https://github.com/atmospy/stormtrack-web)"
TIMEOUT_S = 15
MAX_BYTES = 2_000_000
RETRY_DELAY_S = 5
MIN_INTERVAL_S = 60  # hard floor; also the default
BUCKET_MID_S = {"5min": 150.0, "10min": 450.0, "15min": 750.0}  # assumed bucket midpoints (age)
BUCKET_AGE_S = {"5min": (0.0, 300.0), "10min": (300.0, 600.0), "15min": (600.0, 900.0)}
SAME_STRIKE_S = 16 * 60
LAT_RANGE = (0.0, 45.0)
LON_RANGE = (55.0, 110.0)
# Approximate extent shown as "coverage" (observed strikes lie within lon 71-98, lat 8-35).
BASE_EXTENT = (66.0, 5.0, 100.0, 38.0)  # lon_min, lat_min, lon_max, lat_max
EXTENT_MARGIN = 1.5
LITERAL_RE = re.compile(r"const\s+lightningData\s*=\s*(\[.*?\])\s*;", re.S)


class FetchError(Exception):
    pass


class UrllibFetcher:
    """``get(url) -> (body, headers)``; reads at most ``max_bytes + 1`` bytes."""

    def __init__(self, timeout: float = TIMEOUT_S, max_bytes: int = MAX_BYTES):
        self.timeout = timeout
        self.max_bytes = max_bytes

    def get(self, url: str):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            body = r.read(self.max_bytes + 1)
            return body, {k.lower(): v for k, v in r.headers.items()}


def parse_page(html: str):
    """Return ``(strikes, n_bad)`` with strikes = [(lon, lat, label)]; raise ValueError if the page
    does not contain the expected literal (page structure changed)."""
    m = LITERAL_RE.search(html)
    if not m:
        raise ValueError("lightningData literal not found (page structure changed?)")
    try:
        items = json.loads(m.group(1))
    except ValueError as e:
        raise ValueError(f"lightningData literal is not valid JSON: {e}") from e
    if not isinstance(items, list):
        raise ValueError("lightningData is not a list")
    out, bad = [], 0
    for it in items:
        try:
            lat, lon, label = float(it["lat"]), float(it["lng"]), it["label"]
            ok = (
                label in BUCKET_MID_S
                and np.isfinite(lat)
                and np.isfinite(lon)
                and LAT_RANGE[0] <= lat <= LAT_RANGE[1]
                and LON_RANGE[0] <= lon <= LON_RANGE[1]
            )
        except (TypeError, KeyError, ValueError):
            ok = False
        if ok:
            out.append((round(lon, 4), round(lat, 4), label))
        else:
            bad += 1
    if items and not out:
        raise ValueError(f"all {bad} lightningData items are invalid (page structure changed?)")
    return out, bad


def dedupe_against_prev(t, lon, lat, prev_rows):
    """Drop strikes already published (same 4-dp position, time within ~16 min), and duplicates
    inside the batch; the earlier time wins. Returns a boolean keep mask over the input arrays."""
    keep = np.ones(len(t), bool)
    seen: dict = {}  # (lon, lat) -> list of times already accepted
    if prev_rows is not None:
        for pt, plon, plat in zip(*(np.asarray(a, "f8") for a in prev_rows)):
            seen.setdefault((round(float(plon), 4), round(float(plat), 4)), []).append(float(pt))
    for i in np.argsort(t, kind="stable"):  # earliest estimate first
        key = (round(float(lon[i]), 4), round(float(lat[i]), 4))
        times = seen.setdefault(key, [])
        if any(abs(float(t[i]) - pt) <= SAME_STRIKE_S for pt in times):
            keep[i] = False
        else:
            times.append(float(t[i]))
    return keep


class IitmDamini:
    id = "iitm-damini"
    name = "IITM Pune Damini lightning network (unofficial feed)"
    licence = (
        "No published licence or terms; used as an unofficial prototype source pending written "
        "permission from IITM Pune / MoES"
    )
    attribution = "Lightning data: IITM Pune (Damini) — unofficial"
    kind = "ground-network"
    time_precision = "bucketed"
    time_uncertainty_s = 150
    unofficial = True
    high_volume = False  # never thinned
    decimals = 4
    stale_s = 900  # 15 min = the oldest age bucket
    default_latency_s = 60  # time is first-seen based; true event->feed latency is unknown
    covers_south_asia = True
    coverage_note = (
        "India and surrounding seas (approximate extent of strikes reported by the feed)"
    )
    coverage_basis = "extent of strikes reported by the feed; not a sensor-coverage map"

    def __init__(
        self,
        fetcher=None,
        min_interval_s: float = MIN_INTERVAL_S,
        sleep=time.sleep,
        url: str = URL,
    ):
        self.fetcher = fetcher or UrllibFetcher()
        self.min_interval_s = max(float(min_interval_s), MIN_INTERVAL_S)
        self.sleep = sleep
        self.url = url

    def _fetch(self):
        try:
            return self.fetcher.get(self.url)
        except urllib.error.HTTPError as e:  # server answered: do not retry
            raise FetchError(f"HTTP {e.code}") from e
        except (urllib.error.URLError, OSError) as first:  # network error: one retry
            self.sleep(RETRY_DELAY_S)
            try:
                return self.fetcher.get(self.url)
            except Exception as e:  # noqa: BLE001
                raise FetchError(f"network error: {e} (after retry; first: {first})") from e

    def poll(self, prev_state, now, window_s, prev_rows=None) -> Batch:
        st = dict(prev_state or {})
        empty = np.empty(0)

        def batch(errors=(), nbytes=0, **kw):
            return Batch(
                empty,
                empty,
                empty,
                empty,
                state=st,
                newest_end=st.get("last_ok"),
                bytes=nbytes,
                latency_s=self.default_latency_s,
                errors=list(errors),
                **kw,
            )

        last = st.get("last_fetch")
        if last is not None and 0 <= now - last < self.min_interval_s:
            return batch()  # polite: no request
        st["last_fetch"] = now  # even on failure, so errors never cause hammering
        st["min_interval_s"] = self.min_interval_s
        try:
            body, headers = self._fetch()
        except Exception as e:  # noqa: BLE001
            return batch([f"{self.id}: {e}"], failed=True)
        if len(body) > MAX_BYTES:
            return batch(
                [f"{self.id}: response larger than {MAX_BYTES} bytes, ignored"], failed=True
            )
        date = headers.get("date")
        if date:
            try:
                st["clock_skew_s"] = round(parsedate_to_datetime(date).timestamp() - now, 1)
            except (TypeError, ValueError):
                pass
        try:
            strikes, n_bad = parse_page(body.decode("utf-8", "replace"))
        except ValueError as e:
            return batch([f"{self.id}: {e}"], nbytes=len(body), failed=True)
        errors = [f"{self.id}: skipped {n_bad} invalid items"] if n_bad else []
        lon = np.array([s[0] for s in strikes], "f8")
        lat = np.array([s[1] for s in strikes], "f8")
        raw = len(strikes)
        # Times first-seen strikes: cold start -> bucket midpoints; once a previous successful
        # poll exists -> spread (deterministically) between that poll and now, constrained to
        # the strike's age bucket. Strikes already published are dropped below, so only NEW
        # strikes ever get a time.
        prev_ok = st.get("last_ok")
        model = "midpoint" if prev_ok is None else "spread"
        t = np.empty(raw, "f8")
        for i, (slon, slat, label) in enumerate(strikes):
            mid = now - BUCKET_MID_S[label]
            t[i] = mid
            if prev_ok is not None:
                amin, amax = BUCKET_AGE_S[label]
                lo, hi = max(prev_ok, now - amax), now - amin
                if hi > lo:
                    u = zlib.crc32(f"{slon:.4f}|{slat:.4f}|{now:.0f}".encode()) / 2**32
                    t[i] = lo + u * (hi - lo)
        keep = dedupe_against_prev(t, lon, lat, prev_rows)
        t, lon, lat = t[keep], lon[keep], lat[keep]
        st["time_model"] = model
        st["prev_poll"] = prev_ok
        st["last_ok"] = now
        st["n_snapshot"] = raw
        st["n_new"] = int(len(t))
        st["n_invalid"] = n_bad
        if len(lon):
            e = st.get("extent") or [lon.min(), lat.min(), lon.max(), lat.max()]
            st["extent"] = [
                round(float(min(e[0], lon.min())), 4),
                round(float(min(e[1], lat.min())), 4),
                round(float(max(e[2], lon.max())), 4),
                round(float(max(e[3], lat.max())), 4),
            ]
        order = np.argsort(t, kind="stable")
        return Batch(
            t[order],
            lon[order],
            lat[order],
            np.full(len(t), np.nan),
            state=st,
            newest_end=now,
            files=1,
            bytes=len(body),
            raw_flashes=raw,
            dropped_quality=n_bad,
            latency_s=self.default_latency_s,
            errors=errors,
        )

    def coverage(self, state: dict) -> dict:
        x0, y0, x1, y1 = BASE_EXTENT
        ext = state.get("extent")
        if ext:  # widen if strikes were observed outside the default box (with margin)
            x0, y0 = min(x0, ext[0] - EXTENT_MARGIN), min(y0, ext[1] - EXTENT_MARGIN)
            x1, y1 = max(x1, ext[2] + EXTENT_MARGIN), max(y1, ext[3] + EXTENT_MARGIN)
        ring = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
        return {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "approximate": True,
                        "label": "Approximate extent of IITM Damini strikes (APPROXIMATE, unofficial)",
                        "basis": self.coverage_basis,
                    },
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }
            ],
        }
