"""India Meteorological Department lightning strikes, from IMD's public GeoServer (UNDOCUMENTED).

IMD's public GeoServer serves the ``imd_ws:lightning_data_v`` layer. Read as WFS GeoJSON it is the current snapshot of strikes (about 20 min) over India and
the surrounding seas, one point per strike::

    {"properties": {"id": 196355535, "date": "2026-11-02Z", "time": "1970-01-01T13:59:49Z",
                    "latitude": 11.41579, "longitude": 96.980714, "amps": 9174, "cloud": "true",
                    "ground": "false", "created_at": "2026-11-02T19:49:02.187Z", "timeduration": 15}}

How the fields were checked (2 Nov 2026, 555 strikes): ``date`` + the time-of-day part of ``time``
is the strike time in UTC. ``created_at`` is the snapshot time in INDIAN time although it is
labelled ``Z`` (shifted by 5 h 30 min it matches the server clock). The snapshot is rewritten every 15 minutes (19:49 then 20:04 IST were seen) and holds only the
preceding ~15 minutes of strikes, which were 6 to 19 minutes older than the snapshot. So strikes
reach us 5 to 35 minutes late; the delay is measured on every poll and published as the latency. ``amps`` is a peak current in amperes
(signed), ``cloud``/``ground`` mark intra-cloud and cloud-to-ground strikes. There is no energy,
so ``energy_fj`` is NaN, and we publish only position and time.

IMD publishes no terms for this service. It is read here once per poll from a descriptive User-Agent, never by
visitors' browsers, and the source is marked ``unofficial``.

Politeness: one request per poll, one retry after 5 s on a network error, a 20 s timeout, an 8 MB
response cap and a minimum interval of 60 s between requests, kept in the source state.

``poll`` never raises: a changed or missing response yields a Batch with an error and no strikes.
"""

from __future__ import annotations

import json
import statistics
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np

from . import Batch

URL = (
    "https://hgmg.imd.gov.in:8443/geoserver/imd_ws/ows?service=WFS&version=1.0.0&request=GetFeature"
    "&typeName=imd_ws:lightning_data_v&outputFormat=application/json"
)
USER_AGENT = "stormtrack-web-ingest (+https://github.com/atmospy/stormtrack-web)"
TIMEOUT_S = 20
MAX_BYTES = 8_000_000
RETRY_DELAY_S = 5
MIN_INTERVAL_S = 60  # hard floor, also the default
MAX_SEEN_IDS = 6000  # strike ids remembered for de-duplication (a snapshot holds ~500)
LAT_RANGE = (0.0, 45.0)
LON_RANGE = (55.0, 110.0)
BASE_EXTENT = (66.0, 5.0, 100.0, 38.0)  # lon_min, lat_min, lon_max, lat_max
EXTENT_MARGIN = 1.5


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


def strike_time(props: dict, now: float) -> float:
    """Unix seconds of a strike: ``date`` + time-of-day of ``time`` (both UTC). A time in the future
    means the snapshot straddles midnight, so the strike belongs to the previous day."""
    day = datetime.fromisoformat(str(props["date"])[:10]).replace(tzinfo=timezone.utc)
    tod = datetime.fromisoformat(str(props["time"]).replace("Z", "+00:00"))
    t = (day + timedelta(hours=tod.hour, minutes=tod.minute, seconds=tod.second)).timestamp()
    return t - 86400 if t > now + 300 else t


def parse(body: bytes, now: float):
    """Return ``(strikes, n_bad)`` with strikes = [(id, t, lon, lat)]; raise ValueError if the
    response is not the expected FeatureCollection (the service changed)."""
    try:
        d = json.loads(body)
    except ValueError as e:
        raise ValueError(f"response is not JSON: {e}") from e
    feats = d.get("features") if isinstance(d, dict) else None
    if not isinstance(feats, list):
        raise ValueError("no features list (service changed?)")
    out, bad = [], 0
    for f in feats:
        try:
            p = f["properties"]
            sid = int(p["id"])
            lon, lat = float(p["longitude"]), float(p["latitude"])
            t = strike_time(p, now)
            ok = (
                np.isfinite(lon)
                and np.isfinite(lat)
                and LAT_RANGE[0] <= lat <= LAT_RANGE[1]
                and LON_RANGE[0] <= lon <= LON_RANGE[1]
                and now - 86400 < t <= now + 300
            )
        except (TypeError, KeyError, ValueError):
            ok = False
        if ok:
            out.append((sid, t, round(lon, 4), round(lat, 4)))
        else:
            bad += 1
    if feats and not out:
        raise ValueError(f"all {bad} features are invalid (service changed?)")
    return out, bad


class ImdLightning:
    id = "imd-lightning"
    name = "IMD lightning (India Meteorological Department public map service, unofficial access)"
    licence = "IMD publishes no licence or terms for this service; credit the India Meteorological Department"
    attribution = "Lightning data: India Meteorological Department (IMD)"
    kind = "ground-network"
    time_precision = "exact"
    time_uncertainty_s = 1
    unofficial = True
    high_volume = False  # about 500 strikes per snapshot; never thinned
    decimals = 4
    stale_s = (
        1800  # the snapshot refreshes every few minutes; half an hour without new strikes is stale
    )
    default_latency_s = 600  # measured 6 to 19 min on 2 Nov 2026; replaced by the measured value
    covers_south_asia = True
    coverage_note = "India and surrounding seas (approximate extent of strikes reported by IMD)"
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
        except urllib.error.HTTPError as e:  # the server answered: do not retry
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
                latency_s=st.get("latency_s", self.default_latency_s),
                errors=list(errors),
                **kw,
            )

        last = st.get("last_fetch")
        if last is not None and 0 <= now - last < self.min_interval_s:
            return batch()  # polite: no request
        st["last_fetch"] = now  # even on failure, so errors never cause hammering
        st["min_interval_s"] = self.min_interval_s
        try:
            body, _headers = self._fetch()
        except Exception as e:  # noqa: BLE001
            return batch([f"{self.id}: {e}"], failed=True)
        if len(body) > MAX_BYTES:
            return batch(
                [f"{self.id}: response larger than {MAX_BYTES} bytes, ignored"], failed=True
            )
        try:
            strikes, n_bad = parse(body, now)
        except ValueError as e:
            return batch([f"{self.id}: {e}"], nbytes=len(body), failed=True)
        errors = [f"{self.id}: skipped {n_bad} invalid features"] if n_bad else []
        seen = list(st.get("seen_ids") or [])
        seen_set = set(seen)
        fresh = [s for s in strikes if s[0] not in seen_set and s[1] >= now - window_s]
        # remember every id in this snapshot (not only the new ones) so it is never re-added
        for s in strikes:
            if s[0] not in seen_set:
                seen.append(s[0])
                seen_set.add(s[0])
        st["seen_ids"] = seen[-MAX_SEEN_IDS:]
        t = np.array([s[1] for s in fresh], "f8")
        lon = np.array([s[2] for s in fresh], "f8")
        lat = np.array([s[3] for s in fresh], "f8")
        if strikes:  # how far behind real time the feed runs, measured on every poll
            ages = [now - s[1] for s in strikes]
            st["latency_s"] = round(statistics.median(ages), 1)
            st["newest_strike_age_s"] = round(min(ages), 1)
        st["prev_poll"] = st.get("last_ok")
        st["last_ok"] = now
        st["n_snapshot"] = len(strikes)
        st["n_new"] = len(fresh)
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
            raw_flashes=len(strikes),
            dropped_quality=n_bad,
            latency_s=st.get("latency_s", self.default_latency_s),
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
                        "label": "Approximate extent of IMD lightning strikes (APPROXIMATE, unofficial access)",
                        "basis": self.coverage_basis,
                    },
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }
            ],
        }
