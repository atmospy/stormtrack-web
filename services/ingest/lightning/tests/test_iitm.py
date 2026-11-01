from __future__ import annotations

import json
import math
import urllib.error

import numpy as np
import pytest
from conftest import NOW, populate
from iitm_fixtures import FakeFetcher, page
from lightning_ingest import pipeline
from lightning_ingest.schema import COLS, validate_all, validate_coverage, validate_flashes
from lightning_ingest.sources import default_sources
from lightning_ingest.sources.goes_glm import GoesGlm
from lightning_ingest.sources.iitm_damini import MAX_BYTES, IitmDamini, parse_page

ITEMS = [(17.9333, 94.1774, "10min"), (22.5, 88.3, "5min"), (12.1, 77.6, "15min")]


def src(fetcher, **kw):
    return IitmDamini(fetcher=fetcher, sleep=lambda s: None, **kw)


def read(out):
    d = out / "lightning"
    return tuple(
        json.loads((d / n).read_text()) for n in ("index.json", "flashes.json", "coverage.geojson")
    )


# ---- parsing --------------------------------------------------------------------------------
def test_parse_real_shape():
    strikes, bad = parse_page(page(ITEMS).decode())
    assert bad == 0
    assert strikes[0] == (94.1774, 17.9333, "10min")  # (lon, lat, label); strings -> floats


def test_parse_missing_literal_and_bad_json():
    with pytest.raises(ValueError, match="not found"):
        parse_page("<html><script>const other = [];</script></html>")
    with pytest.raises(ValueError, match="not valid JSON"):
        parse_page("const lightningData = [{lat: 1}];")


def test_parse_skips_malformed_items_and_counts():
    items = [
        {"lat": "17.9", "lng": "94.1", "label": "5min"},
        {"lat": "abc", "lng": "94.1", "label": "5min"},  # not a number
        {"lat": "17.9", "lng": "94.1", "label": "20min"},  # unknown bucket
        {"lat": "60.0", "lng": "94.1", "label": "5min"},  # outside India box
        {"lat": "17.9", "lng": "20.0", "label": "5min"},
        {"lng": "94.1", "label": "5min"},  # missing key
        "garbage",
        {"lat": "NaN", "lng": "80", "label": "5min"},
    ]
    strikes, bad = parse_page(page(items).decode())
    assert len(strikes) == 1 and bad == 7


def test_parse_empty_list_is_valid_and_all_bad_is_error():
    assert parse_page(page([]).decode()) == ([], 0)
    with pytest.raises(ValueError, match="invalid"):
        parse_page(page([{"lat": "x", "lng": "y", "label": "5min"}]).decode())


def test_bad_page_gives_error_batch_no_strikes_never_raises():
    s = src(FakeFetcher(b"<html>maintenance</html>"))
    b = s.poll(None, NOW, 3600)
    assert len(b.t) == 0 and b.failed and "not found" in b.errors[0]
    assert "last_ok" not in b.state  # a bad page is never counted as fresh


def test_huge_response_rejected():
    b = src(FakeFetcher(b"x" * (MAX_BYTES + 1))).poll(None, NOW, 3600)
    assert len(b.t) == 0 and b.failed and "larger" in b.errors[0]


def test_network_error_one_retry_then_error():
    f = FakeFetcher(exc=urllib.error.URLError("down"))
    sleeps = []
    s = IitmDamini(fetcher=f, sleep=sleeps.append)
    b = s.poll(None, NOW, 3600)
    assert f.calls == 2 and sleeps == [5] and b.failed and len(b.t) == 0
    # a failed attempt still starts the minimum-interval clock
    f.calls = 0
    s.poll(b.state, NOW + 10, 3600)
    assert f.calls == 0


def test_http_error_not_retried():
    f = FakeFetcher(exc=urllib.error.HTTPError("u", 503, "x", {}, None))
    b = src(f).poll(None, NOW, 3600)
    assert f.calls == 1 and b.failed and "503" in b.errors[0]


# ---- time mapping / content -----------------------------------------------------------------
def test_bucket_midpoints_energy_nan_and_clock_skew():
    f = FakeFetcher(page(ITEMS), {"date": "Sun, 01 Nov 2026 19:35:30 GMT"})  # NOW + 5.5 min
    b = src(f).poll(None, NOW, 3600)
    by = dict(zip(zip(b.lon, b.lat), b.t))
    assert by[(94.1774, 17.9333)] == NOW - 450
    assert by[(88.3, 22.5)] == NOW - 150
    assert by[(77.6, 12.1)] == NOW - 750
    assert np.isnan(b.energy_fj).all() and len(b.t) == 3
    assert b.state["clock_skew_s"] == pytest.approx(330.0)
    assert b.newest_end == NOW and list(b.t) == sorted(b.t)


# ---- minimum interval ---------------------------------------------------------------------
def test_min_interval_makes_no_request():
    f = FakeFetcher(page(ITEMS))
    s = src(f)
    b1 = s.poll(None, NOW, 3600)
    assert f.calls == 1
    b2 = s.poll(b1.state, NOW + 59, 3600)
    assert f.calls == 1 and len(b2.t) == 0 and not b2.failed and b2.newest_end == NOW
    b3 = s.poll(b2.state, NOW + 61, 3600)
    assert f.calls == 2 and b3.newest_end == NOW + 61


# ---- de-duplication -------------------------------------------------------------------------
def test_dedupe_across_snapshots_keeps_first_time():
    s = src(FakeFetcher(page([(17.9333, 94.1774, "5min")])), min_interval_s=0)
    b1 = s.poll(None, NOW, 3600)
    first_t = float(b1.t[0])
    s.fetcher = FakeFetcher(
        page(
            [
                (17.9333, 94.1774, "10min"),  # same strike, aged one bucket
                (17.9334, 94.1774, "5min"),  # different strike, nearby 4-dp position
            ]
        )
    )
    b2 = s.poll(b1.state, NOW + 240, 3600, prev_rows=(b1.t, b1.lon, b1.lat))
    assert list(b2.lat) == [17.9334] and list(b2.lon) == [94.1774]
    # a recurrence at the same place much later is a new strike
    s.fetcher = FakeFetcher(page([(17.9333, 94.1774, "5min")]))
    b3 = s.poll(b2.state, NOW + 3000, 3600, prev_rows=(b1.t, b1.lon, b1.lat))
    assert len(b3.t) == 1 and b3.t[0] > first_t + 2000


def test_pipeline_dedup_keeps_one_row_at_first_estimate(tmp_path):
    f = FakeFetcher(page([(17.9333, 94.1774, "5min"), (20.0, 80.0, "15min")]))
    s = src(f, min_interval_s=0)
    pipeline.run(tmp_path, sources=[s], now=NOW, log=lambda *_: None)
    f.body = page([(17.9333, 94.1774, "10min"), (20.0, 80.0, "15min"), (25.0, 90.0, "5min")])
    pipeline.run(tmp_path, sources=[s], now=NOW + 240, log=lambda *_: None)
    idx, fl, _ = read(tmp_path)
    assert len(fl["rows"]) == 3
    from lightning_ingest.pipeline import parse_iso

    row = next(r for r in fl["rows"] if r[1] == 94.1774)
    assert parse_iso(fl["t0"]) + row[0] == pytest.approx(NOW - 150)  # the FIRST estimate
    assert idx["sources"][0]["count"] == 3


# ---- multi-source pipeline ------------------------------------------------------------------
def combined(s3, iitm):
    populate(s3, NOW, minutes=5, sats=(("G19", -75.2),))
    return [GoesGlm(http=s3, workers=2, satellites=["G19"]), iitm]


def test_two_sources_schema_null_energy_and_coverage(s3, tmp_path):
    srcs = combined(s3, src(FakeFetcher(page(ITEMS))))
    res = pipeline.run(tmp_path, sources=srcs, now=NOW, log=lambda *_: None)
    assert res["ok"] and not res["stale"]
    idx, fl, cov = read(tmp_path)
    assert fl["cols"] == COLS == ["dt_s", "lon", "lat", "energy_fj", "src"]
    assert validate_all(idx, fl, cov) == []
    assert [s["id"] for s in idx["sources"]] == ["goes-glm", "iitm-damini"]
    iitm = idx["sources"][1]
    assert iitm["unofficial"] is True and iitm["time_precision"] == "bucketed"
    assert iitm["time_uncertainty_s"] == 150 and iitm["kind"] == "ground-network"
    assert iitm["stale"] is False and iitm["count"] == 3
    assert iitm["licence"].startswith("No published licence or terms")
    assert iitm["attribution"] == "Lightning data: IITM Pune (Damini) — unofficial"
    assert idx["state"]["iitm-damini"]["last_ok"] == NOW
    rows = [r for r in fl["rows"] if r[4] == 1]
    assert len(rows) == 3 and all(r[3] is None for r in rows)
    assert all(r[3] is not None for r in fl["rows"] if r[4] == 0)
    raw = (tmp_path / "lightning" / "flashes.json").read_text()
    assert "NaN" not in raw and "null" in raw
    # 4 dp kept for IITM, 2 dp for GLM
    assert {r[1] for r in rows} == {94.1774, 88.3, 77.6}
    assert [f["properties"]["source"] for f in cov["features"]] == ["goes-glm", "iitm-damini"]
    iitm_cov = cov["features"][1]["properties"]
    assert iitm_cov["approximate"] is True and "not a sensor-coverage map" in iitm_cov["basis"]
    assert "unofficial" in idx["notes"] and "Americas" in idx["notes"] and "India" in idx["notes"]
    ts = [r[0] for r in fl["rows"]]
    assert ts == sorted(ts)


def test_iitm_rows_never_thinned(s3, tmp_path):
    many = [
        (8 + (i % 300) * 0.05, 70 + (i // 300) * 0.05 + (i % 7) * 0.001, "5min")
        for i in range(1500)
    ]
    srcs = combined(s3, src(FakeFetcher(page(many))))
    pipeline.run(tmp_path, max_rows=500, sources=srcs, now=NOW, log=lambda *_: None)
    idx, fl, _ = read(tmp_path)
    n_iitm = sum(1 for r in fl["rows"] if r[4] == 1)
    assert n_iitm == len({(round(a, 4), round(b, 4)) for a, b, _ in many}) > 500
    assert idx["sources"][0]["count"] <= 500 or idx["count"] >= n_iitm


def test_iitm_failure_does_not_take_down_glm(s3, tmp_path):
    f = FakeFetcher(page(ITEMS))
    iitm = src(f, min_interval_s=0)
    srcs = combined(s3, iitm)
    pipeline.run(tmp_path, sources=srcs, now=NOW, log=lambda *_: None)
    glm_before = [r for r in read(tmp_path)[1]["rows"] if r[4] == 0]
    f.body = b"<html>broken</html>"
    later = NOW + 300
    res = pipeline.run(tmp_path, sources=srcs, now=later, log=lambda *_: None)
    assert res["ok"] and any("iitm-damini" in e for e in res["errors"])
    idx, fl, cov = read(tmp_path)
    assert validate_all(idx, fl, cov) == []
    assert idx["sources"][1]["stale"] is True  # an erroring source is marked stale...
    # ...but its rows stay until the window ends
    assert sum(1 for r in fl["rows"] if r[4] == 1) == 3
    assert len([r for r in fl["rows"] if r[4] == 0]) >= len(glm_before) > 0
    assert idx["stale"] is False
    # much later the feed is stale (and the old strikes have left the window)
    much = NOW + 1000
    pipeline.run(tmp_path, sources=srcs, now=much, log=lambda *_: None)
    idx, fl, _ = read(tmp_path)
    assert idx["sources"][1]["stale"] is True
    assert idx["sources"][1]["updated"] == "2026-11-01T19:30:00Z"
    assert "stale for iitm-damini" in idx["notes"]
    # after the window the stale source's rows are gone
    gone = NOW + 3 * 3600
    pipeline.run(tmp_path, sources=srcs, now=gone, window_min=60, log=lambda *_: None)
    assert sum(1 for r in read(tmp_path)[1]["rows"] if r[4] == 1) == 0


def test_glm_failure_does_not_take_down_iitm(s3, tmp_path):
    srcs = combined(s3, src(FakeFetcher(page(ITEMS)), min_interval_s=0))
    pipeline.run(tmp_path, sources=srcs, now=NOW, log=lambda *_: None)
    s3.fail_listing = True
    res = pipeline.run(tmp_path, sources=srcs, now=NOW + 300, log=lambda *_: None)
    idx, fl, _ = read(tmp_path)
    assert res["ok"] and idx["sources"][1]["stale"] is False
    assert idx["stale"] is False  # only stale when EVERY source is


def test_all_sources_stale_flag(s3, tmp_path):
    srcs = combined(s3, src(FakeFetcher(page(ITEMS)), min_interval_s=0))
    pipeline.run(tmp_path, sources=srcs, now=NOW, log=lambda *_: None)
    s3.fail_listing = True
    for s in srcs[1:]:
        s.fetcher = FakeFetcher(exc=OSError("down"))
    res = pipeline.run(tmp_path, sources=srcs, now=NOW + 1200, log=lambda *_: None)
    idx = read(tmp_path)[0]
    assert res["ok"] and idx["stale"] is True and all(s["stale"] for s in idx["sources"])


def test_iitm_min_interval_through_pipeline_keeps_rows(s3, tmp_path):
    f = FakeFetcher(page(ITEMS))
    srcs = combined(s3, src(f))
    pipeline.run(tmp_path, sources=srcs, now=NOW, log=lambda *_: None)
    assert f.calls == 1
    pipeline.run(tmp_path, sources=srcs, now=NOW + 30, log=lambda *_: None)
    assert f.calls == 1  # no request
    idx, fl, _ = read(tmp_path)
    assert sum(1 for r in fl["rows"] if r[4] == 1) == 3 and idx["sources"][1]["stale"] is False


def test_old_four_column_file_is_a_cold_start(s3, tmp_path):
    d = tmp_path / "lightning"
    d.mkdir()
    (d / "index.json").write_text(json.dumps({"schema": 1, "updated": "2026-11-01T19:29:00Z"}))
    (d / "flashes.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "t0": "2026-11-01T19:00:00Z",
                "cols": ["dt_s", "lon", "lat", "energy_fj"],
                "rows": [[0, -80.0, 10.0, 5.0]],
            }
        )
    )
    srcs = combined(s3, src(FakeFetcher(page(ITEMS))))
    res = pipeline.run(tmp_path, sources=srcs, now=NOW, log=lambda *_: None)
    assert res["ok"]
    assert all(len(r) == 5 for r in read(tmp_path)[1]["rows"])


# ---- schema validator ---------------------------------------------------------------------
def good_flashes():
    return {
        "schema": 1,
        "t0": "2026-11-01T19:00:00Z",
        "cols": COLS,
        "rows": [[0, -80.12, 10.0, 5.0, 0], [3, 80.1234, 20.0, None, 1]],
    }


def test_validator_flashes():
    assert validate_flashes(good_flashes(), [2, 4]) == []
    f = good_flashes()
    f["rows"][1][4] = 2
    assert "out of range" in validate_flashes(f, [2, 4])[0]
    f = good_flashes()
    f["rows"][0][1] = -80.123  # 3 dp for a 2 dp source
    assert "2 dp" in validate_flashes(f, [2, 4])[0]
    f = good_flashes()
    f["rows"][1][3] = -1
    assert "energy" in validate_flashes(f, [2, 4])[0]
    f = good_flashes()
    f["rows"][1][3] = math.nan
    assert "energy" in validate_flashes(f, [2, 4])[0]
    f = good_flashes()
    f["rows"][0] = f["rows"][0][:4]
    assert "columns" in validate_flashes(f, [2, 4])[0]
    f = good_flashes()
    f["cols"] = ["dt_s", "lon", "lat", "energy_fj"]
    assert any("cols" in x for x in validate_flashes(f, [2, 4]))


def test_validator_coverage_one_feature_per_source(s3, tmp_path):
    srcs = combined(s3, src(FakeFetcher(page(ITEMS))))
    pipeline.run(tmp_path, sources=srcs, now=NOW, log=lambda *_: None)
    idx, fl, cov = read(tmp_path)
    assert validate_coverage(cov, ["goes-glm", "iitm-damini"]) == []
    cov["features"].pop()
    assert validate_all(idx, fl, cov)
    idx["stale"] = True
    assert any("stale" in p for p in validate_all(idx, fl, read(tmp_path)[2]))


# ---- CLI / registry -------------------------------------------------------------------------
def test_default_is_glm_only_and_iitm_opt_in(monkeypatch):
    assert [s.id for s in default_sources()] == ["goes-glm"]
    assert [s.id for s in default_sources(["goes-glm", "iitm-damini"])] == [
        "goes-glm",
        "iitm-damini",
    ]
    with pytest.raises(ValueError):
        default_sources(["nope"])


def test_cli_source_selection(monkeypatch, tmp_path):
    from lightning_ingest import cli

    seen = {}

    def fake_run(out, prev_url, window, max_rows, sources, log, **kw):
        seen["ids"] = [s.id for s in sources]
        return {"ok": False, "errors": []}

    monkeypatch.setattr(cli.pipeline, "run", fake_run)
    monkeypatch.delenv("LIGHTNING_SOURCES", raising=False)
    cli.main(["--out", str(tmp_path)])
    assert seen["ids"] == ["goes-glm"]
    cli.main(["--out", str(tmp_path), "--source", "goes-glm,iitm-damini"])
    assert seen["ids"] == ["goes-glm", "iitm-damini"]
    cli.main(["--out", str(tmp_path), "--source", "iitm-damini", "--source", "goes-glm"])
    assert seen["ids"] == ["iitm-damini", "goes-glm"]
    monkeypatch.setenv("LIGHTNING_SOURCES", "goes-glm,iitm-damini")
    cli.main(["--out", str(tmp_path)])
    assert seen["ids"] == ["goes-glm", "iitm-damini"]
    with pytest.raises(SystemExit):
        cli.main(["--out", str(tmp_path), "--source", "bogus"])


def test_min_interval_floor_is_60():
    assert IitmDamini(min_interval_s=0).min_interval_s == 60
    assert IitmDamini(min_interval_s=120).min_interval_s == 120


def test_spread_times_between_previous_poll_and_now():
    f = FakeFetcher(page([(20.0, 80.0, "5min")]))
    s = src(f)
    b1 = s.poll(None, NOW, 3600)
    assert b1.state["time_model"] == "midpoint" and b1.t[0] == NOW - 150
    f.body = page([(21.0 + 0.01 * i, 81.0, "5min") for i in range(40)])
    b2 = s.poll(b1.state, NOW + 70, 3600)
    assert b2.state["time_model"] == "spread" and b2.state["prev_poll"] == NOW
    assert len(b2.t) == 40
    assert (b2.t >= NOW).all() and (b2.t <= NOW + 70).all()
    assert b2.t.std() > 5  # spread, not a single midpoint
    # deterministic: the same snapshot gives the same times
    b2b = s.poll(b1.state, NOW + 70, 3600)
    assert list(b2b.t) == list(b2.t)
    # a "10min" strike cannot be younger than 5 min
    f.body = page([(30.0, 90.0, "10min")])
    b3 = s.poll(b2.state, NOW + 140, 3600)
    assert NOW + 140 - 600 <= b3.t[0] <= NOW + 140 - 300 or b3.t[0] == NOW + 140 - 450
