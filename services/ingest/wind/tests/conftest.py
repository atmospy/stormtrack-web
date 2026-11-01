import datetime as dt

import pytest
from stormtrack_ingest_wind import fixtures, http

RUN = dt.datetime(2026, 11, 1, 6, tzinfo=dt.timezone.utc)


@pytest.fixture
def fake_noaa(monkeypatch):
    """Mock bucket: runs listed in `avail` have every fhr; serves .idx and byte ranges."""
    body, idx = fixtures.fake_idx(fixtures.grib_uv(2.0))
    state = {"avail": {"20261101/06"}, "gets": []}

    def has(url):
        return any(f"gfs.{k.split('/')[0]}/{k.split('/')[1]}/" in url for k in state["avail"])

    def head(url, timeout=20):
        return has(url) and url.endswith(".idx")

    def get(url, byte_range=None, timeout=60):
        if not has(url):
            raise http.NotFound(url)
        state["gets"].append((url, byte_range))
        if url.endswith(".idx"):
            return idx.encode()
        a, b = byte_range
        return body[a : (b + 1) if b is not None else None]

    monkeypatch.setattr(http, "head", head)
    monkeypatch.setattr(http, "get", get)
    state["body"], state["idx"] = body, idx
    return state
