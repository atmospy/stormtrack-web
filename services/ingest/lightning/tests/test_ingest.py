from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest
from conftest import NOW, make_glm, populate, utc
from lightning_ingest import pipeline
from lightning_ingest.footprint import angular_distance_deg, coverage_geojson
from lightning_ingest.schema import validate_coverage, validate_flashes, validate_index
from lightning_ingest.sources.goes_glm import GoesGlm, parse_file, parse_name


def src(s3, **kw):
    return GoesGlm(http=s3, workers=2, **kw)


def read_out(out: Path):
    d = out / "lightning"
    return (
        json.loads((d / "index.json").read_text()),
        json.loads((d / "flashes.json").read_text()),
        json.loads((d / "coverage.geojson").read_text()),
    )


def assert_valid(out: Path):
    idx, fl, cov = read_out(out)
    assert validate_index(idx) == []
    assert validate_flashes(fl) == []
    assert validate_coverage(cov) == []
    assert idx["count"] == len(fl["rows"])
    return idx, fl, cov


# ---- parsing ------------------------------------------------------------------------------
def test_parse_name():
    r = parse_name(
        "GLM-L2-LCFA/2026/305/19/OR_GLM-L2-LCFA_G19_s20263051923200_e20263051923400_c20263051923417.nc"
    )
    assert r.sat == "G19" and r.end - r.start == 20 and r.created - r.start == pytest.approx(21.7)
    assert r.start == utc(2026, 11, 1, 19, 23, 20)


def test_parse_time_offset_and_energy():
    start = utc(2026, 11, 1, 19, 23, 20)
    fl = [(start + 3.25, -84.1234, 29.4, 310.0), (start + 19.5, -60.0, 5.0, 1.5)]
    p = parse_file(make_glm(start, fl))
    assert p["t"] == pytest.approx([start + 3.25, start + 19.5], abs=1e-3)
    assert p["lon"] == pytest.approx([-84.1234, -60.0], abs=1e-4)
    assert p["energy_fj"] == pytest.approx([310.0, 1.5], abs=1.0)  # quantisation step is 1 fJ
    assert p["sub_lon"] == pytest.approx(-75.2)


def test_quality_filter_and_fill():
    start = utc(2026, 11, 1, 19, 23, 20)
    fl = [(start + i, -80.0, 10.0, 10.0) for i in range(5)]
    fl[3] = (start + 3, -80.0, 10.0, None)  # fill-valued energy
    data = make_glm(start, fl, quality=[0, 1, 0, 0, 5])
    p = parse_file(data)
    assert len(p["t"]) == 2 and p["n"] == 5 and p["n_bad"] == 3
    assert len(parse_file(data, keep_degraded=True)["t"]) == 4


def test_empty_file():
    assert len(parse_file(make_glm(utc(2026, 11, 1, 19, 0, 0), []))["t"]) == 0


# ---- footprint ----------------------------------------------------------------------------
def test_coverage_antimeridian_and_approximate():
    cov = coverage_geojson({"G18": -137.0, "G19": -75.2})
    assert validate_coverage(cov) == []
    assert cov["features"][0]["properties"]["approximate"] is True
    g = cov["features"][0]["geometry"]
    lons = [
        c[0]
        for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]])
        for r in poly
        for c in r
    ]
    assert min(lons) >= -180 and max(lons) <= 180
    assert max(lons) > 170  # G18 cap wraps over the antimeridian
    assert angular_distance_deg(-75.2, 0, -75.2) == pytest.approx(0)


# ---- end to end ---------------------------------------------------------------------------
def test_cold_start_dedupe_atomic_and_incremental(s3, tmp_path):
    populate(s3, NOW, minutes=10)
    res = pipeline.run(tmp_path, sources=[src(s3)], now=NOW, log=lambda *_: None)
    assert res["ok"] and not res["stale"]
    idx, fl, cov = assert_valid(tmp_path)
    assert idx["sources"][0]["satellites"] == ["G18", "G19"]
    assert idx["stale"] is False
    first_count = idx["count"]
    assert first_count > 0
    # index is written last; no temp files left
    assert not [p for p in (tmp_path / "lightning").iterdir() if p.name.startswith(".")]
    n_get = len(s3.gets)
    # second run, nothing new: no object downloads, same rows
    res2 = pipeline.run(tmp_path, sources=[src(s3)], now=NOW + 10, log=lambda *_: None)
    assert res2["files"] == 0
    assert not [u for u in s3.gets[n_get:] if "list-type" not in u]
    assert assert_valid(tmp_path)[0]["count"] == first_count
    # a new file arrives: only that one is downloaded
    nt = (NOW - 30) // 20 * 20 + 20
    s3.add("G19", nt - 20 * 0, [(nt + 1, -70.0, 12.0, 5.0)])
    n_get = len(s3.gets)
    res3 = pipeline.run(tmp_path, sources=[src(s3)], now=NOW + 40, log=lambda *_: None)
    assert res3["files"] == 1
    assert len([u for u in s3.gets[n_get:] if "list-type" not in u]) == 1
    assert assert_valid(tmp_path)[0]["count"] == first_count + 1


def test_overlap_rule_keeps_flash_from_nearest_satellite(s3, tmp_path):
    t = (NOW - 120) // 20 * 20
    # same physical flash at ~ -100 lon (nearer G19=-75.2? no: |−100+75.2|=24.8 vs |−100+137|=37)
    s3.add("G19", t, [(t + 2, -100.0, 25.0, 40.0)], sub_lon=-75.2)
    s3.add("G18", t, [(t + 2, -100.05, 25.02, 41.0)], sub_lon=-137.0)
    # and one nearer to G18
    s3.add("G18", t + 20, [(t + 22, -120.0, 25.0, 40.0)], sub_lon=-137.0)
    s3.add("G19", t + 20, [(t + 22, -120.04, 25.0, 40.0)], sub_lon=-75.2)
    pipeline.run(tmp_path, sources=[src(s3)], now=NOW, log=lambda *_: None)
    _, fl, _ = assert_valid(tmp_path)
    lons = sorted(r[1] for r in fl["rows"])
    assert lons == [-120.0, -100.0]


def test_window_pruning(s3, tmp_path):
    old = NOW - 50 * 60
    s3.add("G19", old // 20 * 20, [(old // 20 * 20 + 1, -80.0, 10.0, 1.0)])
    recent = (NOW - 60) // 20 * 20
    s3.add("G19", recent, [(recent + 1, -81.0, 11.0, 1.0)])
    pipeline.run(
        tmp_path, window_min=60, sources=[src(s3, satellites=["G19"])], now=NOW, log=lambda *_: None
    )
    assert assert_valid(tmp_path)[0]["count"] == 2
    # 20 min later the 50-minute-old flash is outside a 60 min window
    later = NOW + 20 * 60
    s3.add("G19", (later - 40) // 20 * 20, [((later - 40) // 20 * 20 + 1, -82.0, 12.0, 1.0)])
    pipeline.run(
        tmp_path,
        window_min=60,
        sources=[src(s3, satellites=["G19"])],
        now=later,
        log=lambda *_: None,
    )
    _, fl, _ = assert_valid(tmp_path)
    assert sorted(r[1] for r in fl["rows"]) == [-82.0, -81.0]


def test_decimation_cap_and_note(s3, tmp_path):
    rng = np.random.default_rng(1)
    t = (NOW - 200) // 20 * 20
    for k in range(6):
        fl = [
            (t + k * 20 + rng.uniform(0, 19), rng.uniform(-100, -50), rng.uniform(-20, 40), 5.0)
            for _ in range(2000)
        ]
        s3.add("G19", t + k * 20, fl)
    pipeline.run(
        tmp_path,
        window_min=3,
        max_rows=1000,
        sources=[src(s3, satellites=["G19"])],
        now=NOW,
        log=lambda *_: None,
    )
    idx, fl, _ = assert_valid(tmp_path)
    assert 100 < idx["count"] <= 1000, idx["count"]
    assert "sample" in idx["notes"] and "1000" in idx["notes"]
    ts = [r[0] for r in fl["rows"]]
    assert ts == sorted(ts)
    # thinning is uniform in time: first and second half retain similar counts
    mid = (ts[0] + ts[-1]) / 2
    a = sum(1 for x in ts if x < mid)
    assert 0.7 < a / (len(ts) - a) < 1.4
    # re-running adds nothing new and the cap still holds
    pipeline.run(
        tmp_path,
        max_rows=200,
        sources=[src(s3, satellites=["G19"])],
        now=NOW + 5,
        log=lambda *_: None,
    )
    assert read_out(tmp_path)[0]["count"] <= 200


def test_stale_keeps_previous_files(s3, tmp_path):
    populate(s3, NOW, minutes=5, sats=(("G19", -75.2),))
    pipeline.run(tmp_path, sources=[src(s3, satellites=["G19"])], now=NOW, log=lambda *_: None)
    before = (tmp_path / "lightning" / "flashes.json").read_bytes()
    # 15 minutes later nothing new has been published -> stale, files kept
    res = pipeline.run(
        tmp_path, sources=[src(s3, satellites=["G19"])], now=NOW + 15 * 60, log=lambda *_: None
    )
    assert res["ok"] and res["stale"]
    assert (tmp_path / "lightning" / "flashes.json").read_bytes() == before
    idx, _, _ = assert_valid(tmp_path)
    assert idx["stale"] is True and "stale" in idx["notes"].lower()


def test_unreachable_keeps_previous_and_cold_fails(s3, tmp_path):
    populate(s3, NOW, minutes=5, sats=(("G19", -75.2),))
    s = src(s3, satellites=["G19"])
    # cold start with a dead network: exit non-zero equivalent, nothing written
    s3.fail_listing = True
    res = pipeline.run(tmp_path, sources=[s], now=NOW, log=lambda *_: None)
    assert not res["ok"] and not (tmp_path / "lightning").exists()
    s3.fail_listing = False
    pipeline.run(tmp_path, sources=[s], now=NOW, log=lambda *_: None)
    before = (tmp_path / "lightning" / "flashes.json").read_bytes()
    s3.fail_listing = True
    res = pipeline.run(tmp_path, sources=[s], now=NOW + 60, log=lambda *_: None)
    assert res["ok"] and res["stale"]
    assert (tmp_path / "lightning" / "flashes.json").read_bytes() == before
    assert assert_valid(tmp_path)[0]["stale"] is True


def test_prev_url_stateless(s3, tmp_path):
    populate(s3, NOW, minutes=5, sats=(("G19", -75.2),))
    a, b = tmp_path / "a", tmp_path / "b"
    pipeline.run(a, sources=[src(s3, satellites=["G19"])], now=NOW, log=lambda *_: None)
    n = len(s3.gets)
    # new empty output dir, previous output given by a path standing in for the base URL
    pipeline.run(
        b, prev_url=str(a), sources=[src(s3, satellites=["G19"])], now=NOW + 5, log=lambda *_: None
    )
    assert [u for u in s3.gets[n:] if "list-type" not in u] == []
    assert read_out(a)[0]["count"] == read_out(b)[0]["count"]


def test_stale_satellite_detected_not_hardcoded(s3, tmp_path):
    populate(s3, NOW, minutes=5, sats=(("G19", -75.2),))
    # G16 stopped delivering 2 days ago
    old = utc(2026, 10, 30, 12, 0, 0)
    s3.add("G16", old, [(old + 1, -80.0, 10.0, 1.0)])
    res = pipeline.run(tmp_path, sources=[src(s3)], now=NOW, log=lambda *_: None)
    idx, _, _ = assert_valid(tmp_path)
    assert idx["sources"][0]["satellites"] == ["G19"]
    assert "G16 not used" in idx["notes"] and "G18 not used" in idx["notes"]
    assert res["ok"]


def test_no_credentials_or_local_paths_in_output(s3, tmp_path):
    populate(s3, NOW, minutes=3, sats=(("G19", -75.2),))
    pipeline.run(tmp_path, sources=[src(s3, satellites=["G19"])], now=NOW, log=lambda *_: None)
    for p in (tmp_path / "lightning").iterdir():
        assert str(tmp_path) not in p.read_text()
        assert oct(os.stat(p).st_mode & 0o777) == "0o644"
