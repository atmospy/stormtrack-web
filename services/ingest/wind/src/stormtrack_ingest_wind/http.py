"""Tiny stdlib HTTP layer with retries/backoff. Tests monkeypatch `get`/`head`."""

from __future__ import annotations

import logging
import random
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger("stormtrack.wind")
UA = "stormtrack-ingest-wind/0.1 (+https://github.com/atmospy/stormtrack-web)"
STATS = {"bytes": 0, "requests": 0}
_LOCK = threading.Lock()


# Minimum seconds between requests per host substring. ECMWF's S3 answers 503 SlowDown in bursts
# (even to HEAD/index requests), so we pace it; NOAA's bucket copes with full parallelism.
PACE = {"ecmwf-forecasts": 0.3, "data.ecmwf.int": 0.2, "ecmwf-open-data": 0.2}
_NEXT = {}


def _pace(url: str) -> None:
    for host, gap in PACE.items():
        if host in url:
            with _LOCK:
                t = max(time.monotonic(), _NEXT.get(host, 0.0))
                _NEXT[host] = t + gap
            wait = t - time.monotonic()
            if wait > 0:
                time.sleep(wait)


class NotFound(Exception):
    pass


def _open(req, timeout):
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):  # S3 public buckets answer 403 for missing keys
            raise NotFound(req.full_url) from e
        raise


def _retry(fn, tries=20, base=1.0):
    for i in range(tries):
        try:
            return fn()
        except NotFound:
            raise
        except Exception as e:  # network / 5xx / truncated read
            if i == tries - 1:
                raise
            wait = min(base * 1.6**i, 12) * (
                0.75 + 0.5 * random.random()
            )  # jitter: S3 503 SlowDown
            log.warning("retry %d/%d after %s: %s", i + 1, tries - 1, wait, e)
            time.sleep(wait)


def get(url: str, byte_range=None, timeout: float = 60, tries: int = 20) -> bytes:
    """GET (optionally `bytes=a-b` inclusive; b may be None for open-ended)."""

    def go():
        _pace(url)
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        if byte_range is not None:
            a, b = byte_range
            req.add_header("Range", f"bytes={a}-{'' if b is None else b}")
        with _open(req, timeout) as r:
            data = r.read()
        if byte_range is not None and byte_range[1] is not None:
            want = byte_range[1] - byte_range[0] + 1
            if len(data) != want:
                raise IOError(f"short read {len(data)} != {want}")
        with _LOCK:
            STATS["bytes"] += len(data)
            STATS["requests"] += 1
        return data

    return _retry(go, tries=tries)


def head(url: str, timeout: float = 20) -> bool:
    """True if the object exists."""

    def go():
        _pace(url)
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        try:
            with _open(req, timeout):
                return True
        except NotFound:
            return False

    return _retry(go, tries=3)
