import json

import numpy as np
import pandas as pd
import pytest
from conftest import make_obs
from storms_ingest import active, cone, history, stats
from storms_ingest.common import category, split_antimeridian
from storms_ingest.validate import validate_active, validate_history, validate_index, validate_stats

# --- categories -------------------------------------------------------------


@pytest.mark.parametrize(
    "w,lab",
    [
        (0, "TD"),
        (33, "TD"),
        (33.9, "TD"),
        (34, "TS"),
        (63, "TS"),
        (64, "C1"),
        (82, "C1"),
        (83, "C2"),
        (95, "C2"),
        (96, "C3"),
        (112, "C3"),
        (113, "C4"),
        (136, "C4"),
        (137, "C5"),
        (185, "C5"),
    ],
)
def test_category_thresholds(w, lab):
    assert category(w) == lab


def test_category_unknown():
    assert category(None) is None and category(float("nan")) is None


# --- dateline ---------------------------------------------------------------


def test_split_antimeridian_interpolates():
    parts, vals = split_antimeridian(
        [170.0, 179.0, -179.0, -170.0],
        [10.0, 11.0, 13.0, 14.0],
        {
            "w": [10.0, 20.0, 40.0, 50.0],
            "t": [
                "2026-01-01T00:00:00Z",
                "2026-01-01T06:00:00Z",
                "2026-01-01T12:00:00Z",
                "2026-01-01T18:00:00Z",
            ],
        },
    )
    assert len(parts) == 2
    assert parts[0][-1] == (180.0, 12.0) and parts[1][0] == (-180.0, 12.0)
    assert vals["w"][2] == 30.0 and vals["w"][3] == 30.0 and vals["w"][4] == 40.0
    assert vals["t"][2] == "2026-01-01T09:00:00Z"
    assert sum(len(p) for p in parts) == len(vals["w"]) == 6


def test_history_dateline_split_and_range():
    obs = make_obs("S1", [170, 175, 179, -179, -175, -170], [10, 11, 12, 13, 14, 15])
    storms = pd.DataFrame(
        [
            {
                "storm_id": "S1",
                "year": 2026,
                "name": None,
                "start_time": obs.time.min(),
                "end_time": obs.time.max(),
                "max_wind": 55.0,
                "peak_grade": None,
            }
        ]
    )
    coll, skipped = history.build_history(obs, storms)
    g = coll["features"][0]["geometry"]
    assert g["type"] == "MultiLineString"
    assert all(-180 <= x <= 180 for part in g["coordinates"] for x, _ in part)
    assert validate_history(coll) == []


def test_history_simplifies_and_rounds():
    lons = np.linspace(80, 90, 200)
    lats = 10 + 0.0001 * np.sin(lons)  # essentially straight
    obs = make_obs("S2", lons, lats)
    storms = pd.DataFrame(
        [
            {
                "storm_id": "S2",
                "year": 2026,
                "name": "X",
                "start_time": obs.time.min(),
                "end_time": obs.time.max(),
                "max_wind": 70.0,
                "peak_grade": "SCS",
            }
        ]
    )
    coll, _ = history.build_history(obs, storms)
    f = coll["features"][0]
    assert len(f["geometry"]["coordinates"]) < 10
    assert f["properties"]["category"] == "C1" and f["properties"]["imd_grade"] == "SCS"
    assert validate_history(coll) == []


def test_history_skips_single_fix():
    obs = make_obs("S3", [80.0], [10.0])
    storms = pd.DataFrame(
        [
            {
                "storm_id": "S3",
                "year": 2026,
                "name": None,
                "start_time": obs.time.min(),
                "end_time": obs.time.max(),
                "max_wind": None,
                "peak_grade": None,
            }
        ]
    )
    coll, skipped = history.build_history(obs, storms)
    assert coll["features"] == [] and skipped == ["S3"]


# --- cone -------------------------------------------------------------------


def test_cone_contains_forecast_points(fst_mid):
    radii = {12: 50.0, 24: 80.0, 36: 110.0, 48: 150.0, 60: 190.0, 72: 230.0, 96: 330.0, 120: 440.0}
    fc = fst_mid[fst_mid.tech == "OFCL"].drop_duplicates("tau")
    geom = cone.cone_geometry(fc, radii)
    from shapely.geometry import Point, shape

    poly = shape(geom).buffer(1e-6)
    inside = [poly.contains(Point(r.lon, r.lat)) for r in fc.itertuples() if r.tau <= 120]
    assert all(inside) and len(inside) >= 6
    assert geom["type"] in ("Polygon", "MultiPolygon")


def test_cone_across_dateline_valid_ranges():
    fc = pd.DataFrame(
        {"tau": [0, 12, 24, 36], "lat": [20, 21, 22, 23], "lon": [175.0, 179.0, -177.0, -173.0]}
    )
    g = cone.cone_geometry(fc, {12: 100.0, 24: 150.0, 36: 200.0})
    assert g["type"] == "MultiPolygon"
    from storms_ingest.common import iter_coords

    assert all(-180 <= x <= 180 and -90 <= y <= 90 for x, y in iter_coords(g))


def test_estimate_radii_small_sample_says_so():
    errs = pd.DataFrame({"atcf_id": ["AL012025"] * 5, "tau": [12] * 5, "track_err_km": [10.0] * 5})
    r = cone.estimate_radii(errs, [2025], min_n=30)
    assert r["radii_km"] == {} and "No cone" in r["basis"]


def test_season_errors_offline_matches_library(bdeck, ofcl_deck, tmp_path, monkeypatch):
    """Score the fixture storm end-to-end through our code path (fetch stubbed)."""
    from pathlib import Path

    fix = Path(__file__).parent / "fixtures"
    files = {
        "aal052025.dat.gz": (fix / "aal052025_ofcl.dat").read_bytes(),
        "bal052025.dat.gz": (fix / "bal052025.dat").read_bytes(),
    }

    def fetch(url, timeout=0):
        return files[url.rsplit("/", 1)[1]]

    monkeypatch.setattr(
        cone, "list_season_storms", lambda y, timeout=60.0, fetch=None: [("al", "05")]
    )
    e = cone.season_errors(2025, tmp_path, fetch=fetch)
    assert len(e) > 100 and set(e.columns) >= {"tau", "track_err_km"}
    assert (tmp_path / "2025" / "al05.parquet").exists()
    # second run is served from the per-storm cache: no download at all
    e2 = cone.season_errors(
        2025, tmp_path, fetch=lambda *a, **k: (_ for _ in ()).throw(AssertionError("network used"))
    )
    assert len(e2) == len(e)
    # a failed download is not cached and not fatal
    assert (
        cone.score_storm(
            2025,
            "al",
            "06",
            fetch=lambda *a, **k: (_ for _ in ()).throw(OSError("x")),
            cache_dir=tmp_path,
        )
        is None
    )
    assert not (tmp_path / "2025" / "al06.parquet").exists()
    r = cone.estimate_radii(e, [2025], min_n=10)
    km = r["radii_km"]
    assert km and all(a < b for a, b in zip(sorted(km.values()), sorted(km.values())[1:]))
    assert 10 < km[24] < 400 and km[120] > km[24]
    assert "not NHC" in r["basis"] and "our estimate" in r["basis"].lower()


# --- active ----------------------------------------------------------------


class FakeBT:
    def __init__(self, obs):
        self.observations = obs


def test_build_active_offline(bdeck, fst_mid):
    radii = {
        "radii_km": {12: 50.0, 24: 80.0, 36: 110.0, 48: 150.0, 72: 230.0, 96: 330.0, 120: 440.0},
        "basis": "test basis",
    }
    jt = make_obs("IO042026", [86.6, 86.0, 85.0, 84.0], [11.6, 12.0, 12.6, 13.4], [35, 40, 45, 50])

    def fa(src, timeout):
        return FakeBT(bdeck if src == "nhc" else jt)

    def ff(sid, src):
        if src == "jtwc":
            raise LookupError("blocked")
        return fst_mid[fst_mid.tech == "OFCL"]

    coll, rep = active.build_active(radii, fetch_active_fn=fa, fetch_forecast_fn=ff)
    assert validate_active(coll) == []
    kinds = {}
    for f in coll["features"]:
        kinds.setdefault(f["properties"]["id"], []).append(f["properties"]["kind"])
    assert kinds["IO042026"] == ["position", "track"]  # no forecast: omitted, not failed
    assert kinds["AL052025"] == ["position", "track", "forecast", "cone"]
    assert rep["forecast_unavailable"] == ["IO042026"] and rep["forecast_ok"] == ["AL052025"]
    pos = next(
        f
        for f in coll["features"]
        if f["properties"]["id"] == "IO042026" and f["properties"]["kind"] == "position"
    )
    assert pos["properties"]["wind_period_min"] == 1 and pos["properties"]["category"] == {
        "scale": "saffir-simpson",
        "label": "TS",
    }
    assert pos["properties"]["basin"] == "NI" and pos["properties"]["agency"] == "JTWC"
    assert pos["properties"]["heading_deg"] is not None and pos["properties"]["time"].endswith("Z")
    cone_f = next(f for f in coll["features"] if f["properties"]["kind"] == "cone")
    from shapely.geometry import Point, shape

    poly = shape(cone_f["geometry"]).buffer(1e-6)
    fcf = next(f for f in coll["features"] if f["properties"]["kind"] == "forecast")
    assert all(
        poly.contains(Point(c))
        for c, t in zip(fcf["geometry"]["coordinates"], fcf["properties"]["taus"])
        if t <= 120
    )
    json.dumps(coll, allow_nan=False)


def test_build_active_partial_and_total_failure(bdeck):
    def fa(src, timeout):
        if src == "jtwc":
            raise OSError("down")
        return FakeBT(bdeck)

    coll, rep = active.build_active(
        None,
        fetch_active_fn=fa,
        fetch_forecast_fn=lambda s, src: (_ for _ in ()).throw(OSError("x")),
    )
    assert rep["ok"] == ["nhc"] and "jtwc" in rep["failed"] and validate_active(coll) == []

    def bad(src, timeout):
        raise OSError("down")

    _, rep = active.build_active(None, fetch_active_fn=bad)
    assert rep["ok"] == []


def test_empty_active_is_valid():
    coll, rep = active.build_active(
        None, fetch_active_fn=lambda s, t: FakeBT(pd.DataFrame(columns=["storm_id"]))
    )
    assert coll["features"] == [] and validate_active(coll) == []


def test_southern_hemisphere_basin_codes():
    assert active.contract_basin("SH", 90.0) == "SI" and active.contract_basin("SH", 160.0) == "SP"
    assert active.contract_basin("NI", 86.0) == "NI"


# --- stats ------------------------------------------------------------------


def test_stats_shapes_and_validation():
    parts = []
    for y, w in (
        (2018, [30, 70, 100, 60]),
        (2019, [30, 40, 45, 30]),
        (2019, [35, 50, 80, 100, 120, 90]),
    ):
        sid = f"{y}-{len(parts)}"
        o = make_obs(
            sid,
            list(range(80, 80 + len(w))),
            list(range(10, 10 + len(w))),
            w,
            start=f"{y}-10-01 00:00",
        )
        o["year"] = y
        parts.append(o)
    obs = pd.concat(parts, ignore_index=True)
    s = stats.build_stats(obs, "NI")
    assert validate_stats(s) == []
    a = {r["year"]: r for r in s["annual"]}
    assert a[2019]["storms"] == 2 and a[2019]["hurricane"] == 1 and a[2018]["major"] == 1
    assert a[2018]["ace"] > 0
    assert any(r["max_dwind_kt_24h"] >= 30 for r in s["rapid_intensification"])
    assert "3-minute" in s["notes"] and "1-minute" in s["notes"] and "provisional" in s["notes"]
    json.dumps(s, allow_nan=False)


def test_validators_catch_errors():
    bad = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [200, 10]},
                "properties": {"kind": "position", "id": "X"},
            }
        ],
    }
    assert validate_active(bad)
    assert validate_index({"schema": 2})
