from __future__ import annotations

import json
import urllib.error
from datetime import datetime, timezone

import numpy as np
import pytest
from lightning_ingest.sources import default_sources
from lightning_ingest.sources.imd_wfs import ImdLightning, parse, strike_time

NOW = datetime(2026, 11, 2, 14, 30, tzinfo=timezone.utc).timestamp()


def feature(sid, tod, lon=88.3, lat=22.5, date="2026-11-02Z", amps=9174, ground="false"):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "id": sid,
            "date": date,
            "time": f"1970-01-01T{tod}Z",
            "latitude": lat,
            "longitude": lon,
            "amps": amps,
            "cloud": "true" if ground == "false" else "false",
            "ground": ground,
            "created_at": "2026-11-02T19:49:02.187Z",
            "timeduration": 15,
        },
    }


def body(*feats) -> bytes:
    return json.dumps({"type": "FeatureCollection", "features": list(feats)}).encode()


class Fake:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = 0

    def get(self, url):
        self.calls += 1
        r = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        if isinstance(r, Exception):
            raise r
        return r, {}


def src(fetcher, **kw):
    return ImdLightning(fetcher=fetcher, sleep=lambda s: None, **kw)


def test_strike_time_is_date_plus_utc_time_of_day():
    t = strike_time({"date": "2026-11-02Z", "time": "1970-01-01T13:59:49Z"}, NOW)
    assert datetime.fromtimestamp(t, timezone.utc) == datetime(
        2026, 11, 2, 13, 59, 49, tzinfo=timezone.utc
    )


def test_strike_just_before_midnight_belongs_to_the_previous_day():
    now = datetime(2026, 11, 3, 0, 4, tzinfo=timezone.utc).timestamp()
    t = strike_time({"date": "2026-11-03Z", "time": "1970-01-01T23:58:10Z"}, now)
    assert datetime.fromtimestamp(t, timezone.utc) == datetime(
        2026, 11, 2, 23, 58, 10, tzinfo=timezone.utc
    )


def test_parse_counts_and_skips_bad_features():
    ok = feature(1, "14:10:00")
    bad = [
        feature(2, "14:10:00", lat=60.0),  # outside the India box
        feature(3, "14:10:00", lon=20.0),
        {"properties": {"id": 4}},  # missing fields
        feature(5, "14:10:00", date="2026-10-20Z"),  # a day or more old
    ]
    strikes, n_bad = parse(body(ok, *bad), NOW)
    assert [s[0] for s in strikes] == [1] and n_bad == 4


def test_parse_rejects_a_changed_service():
    with pytest.raises(ValueError, match="not JSON"):
        parse(b"<html>moved</html>", NOW)
    with pytest.raises(ValueError, match="no features"):
        parse(b'{"type": "Other"}', NOW)
    with pytest.raises(ValueError, match="all 1 features are invalid"):
        parse(body({"properties": {"id": 1}}), NOW)
    assert parse(body(), NOW) == ([], 0)  # an empty snapshot is valid


def test_poll_returns_new_strikes_sorted_and_measures_latency():
    f = Fake(body(feature(11, "14:20:00", lon=90.0), feature(10, "14:10:00", lon=80.0)))
    b = src(f).poll(None, NOW, 3600)
    assert not b.failed and list(b.lon) == [80.0, 90.0]  # oldest first
    assert list(b.t) == sorted(b.t) and np.isnan(b.energy_fj).all()
    assert b.latency_s == 900.0  # median age: (20 + 10) / 2 min
    assert b.state["n_snapshot"] == 2 and b.state["n_new"] == 2


def test_strikes_already_seen_are_not_added_again():
    f = Fake(
        body(feature(10, "14:10:00"), feature(11, "14:20:00")),
        body(feature(11, "14:20:00"), feature(12, "14:25:00")),
    )
    s = src(f)
    first = s.poll(None, NOW, 3600)
    second = s.poll(first.state, NOW + 120, 3600)
    assert len(first.t) == 2 and len(second.t) == 1  # only id 12 is new


def test_minimum_interval_makes_no_request():
    f = Fake(body(feature(10, "14:10:00")))
    s = src(f, min_interval_s=1)  # a smaller value is raised to the 60 s floor
    first = s.poll(None, NOW, 3600)
    again = s.poll(first.state, NOW + 30, 3600)
    assert f.calls == 1 and len(again.t) == 0 and not again.failed


def test_failures_never_raise():
    assert src(Fake(urllib.error.HTTPError("u", 503, "x", {}, None))).poll(None, NOW, 3600).failed
    f = Fake(urllib.error.URLError("down"))
    b = src(f).poll(None, NOW, 3600)
    assert b.failed and f.calls == 2  # one retry after a network error
    assert src(Fake(b"<html>")).poll(None, NOW, 3600).failed


def test_registered_and_marked_unofficial():
    (s,) = default_sources(["imd-lightning"])
    assert s.id == "imd-lightning" and s.unofficial and s.covers_south_asia
    assert s.coverage({})["features"][0]["properties"]["approximate"] is True
