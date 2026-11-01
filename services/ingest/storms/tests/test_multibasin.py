"""Offline tests for the all-basin history/stats pipeline and the global active job."""

import gzip
import json

import numpy as np
import pandas as pd
import pytest
import stormtrack as st
from conftest import make_obs
from storms_ingest import active, basins, cli
from storms_ingest.common import iter_coords
from storms_ingest.history import build_history
from storms_ingest.stats import build_stats
from storms_ingest.validate import (
    validate_active,
    validate_all_index,
    validate_history,
    validate_index,
    validate_stats,
)

# (basin, genesis lon track, lat track) -- every track has a different geography
TRACKS = {
    "NA": ([-60 - 2.0 * i for i in range(30)], [12 + 0.5 * i for i in range(30)]),
    "EP": ([-100 - 1.5 * i for i in range(30)], [12 + 0.3 * i for i in range(30)]),
    # West Pacific: moves west, starts east of the dateline -> crosses +-180 westward
    "WP": ([-172 - 3.0 * i for i in range(30)], [10 + 0.4 * i for i in range(30)]),
    "NI": ([88 - 0.5 * i for i in range(30)], [12 + 0.3 * i for i in range(30)]),
    # South Indian: stays inside 20E-135E, but also run one across 0 (no false split)
    "SI": ([60 + 2.0 * i for i in range(30)], [-12 - 0.4 * i for i in range(30)]),
    # South Pacific: moves east across the dateline (179E -> W longitudes)
    "SP": ([165 + 2.0 * i for i in range(30)], [-14 - 0.3 * i for i in range(30)]),
    "SA": ([-30 + 1.5 * i for i in range(30)], [-25 - 0.2 * i for i in range(30)]),
}
SUMMER = {"SI": "2025-01-10 00:00", "SP": "2025-02-10 00:00", "SA": "2025-03-10 00:00"}


def fake_obs(basin):
    lons, lats = TRACKS[basin]
    lons = [(x + 180) % 360 - 180 for x in lons]
    frames = []
    for k, year_start in enumerate(("2024-08-01 00:00", SUMMER.get(basin, "2025-09-01 00:00"))):
        winds = [25 + 4 * i for i in range(30)] if k else [None] * 30  # one storm has no wind
        o = make_obs(f"{basin}{k}", lons, lats, winds, f"S{k}", basin, year_start)
        o["track_type"] = "main"
        o["wind_agency"] = np.where(o["wind"].isna(), None, "wmo")
        frames.append(o)
    obs = pd.concat(frames, ignore_index=True)
    obs["year"] = obs["time"].dt.year
    return obs


def fake_storms(obs):
    g = obs.groupby("storm_id")
    st_ = pd.DataFrame(
        {
            "storm_id": list(g.groups),
            "year": g["year"].first().to_numpy(),
            "name": g["name"].first().to_numpy(),
            "basin": g["basin"].first().to_numpy(),
            "start_time": g["time"].min().to_numpy(),
            "end_time": g["time"].max().to_numpy(),
            "max_wind": g["wind"].max().to_numpy(),
            "peak_grade": None,
        }
    )
    return st_


@pytest.fixture
def patched(monkeypatch):
    def load(basin, cache_dir=None):
        obs = fake_obs(basin)
        return obs, fake_storms(obs), ["IMD", "IBTrACS"] if basin == "NI" else ["IBTrACS"]

    monkeypatch.setattr(basins, "load_basin", load)


def test_basin_list():
    assert basins.basin_list("all") == list(basins.BASINS)
    assert basins.basin_list("wp, na,WP") == ["NA", "WP"]
    with pytest.raises(ValueError):
        basins.basin_list("XX")


def test_multi_basin_cli_outputs_validate(tmp_path, patched):
    assert cli.main(["--out", str(tmp_path), "--only", "history", "--basin", "all"]) == 0
    s = tmp_path / "storms"
    ix = json.loads((s / "index.json").read_text())
    ai = json.loads((s / "history" / "all-index.json").read_text())
    assert validate_index(ix) == [] and validate_all_index(ai) == []
    assert list(ix["history"]) == list(basins.BASINS) == [r["id"] for r in ai["basins"]]
    for b, h in ix["history"].items():
        hp, sp = s / "history" / f"{b}.geojson", s / "stats" / f"{b}.json"
        coll = json.loads(hp.read_text())
        assert validate_history(coll, b) == []
        assert {f["properties"]["basin"] for f in coll["features"]} == {b}
        assert validate_stats(json.loads(sp.read_text())) == []
        assert h["count"] == len(coll["features"]) == 2
        assert h["bytes"] == hp.stat().st_size
        assert h["gzip_bytes"] == len(gzip.compress(hp.read_bytes(), compresslevel=6))
        assert h["file"] == f"storms/history/{b}.geojson"
    row = {r["id"]: r for r in ai["basins"]}
    assert row["WP"]["name"] == "West Pacific"
    assert ai["total_gzip_bytes"] == sum(r["gzip_bytes"] for r in ai["basins"])


def test_subset_run_keeps_other_basins(tmp_path, patched):
    assert cli.main(["--out", str(tmp_path), "--only", "history", "--basin", "WP"]) == 0
    assert cli.main(["--out", str(tmp_path), "--only", "history", "--basin", "NA,SP"]) == 0
    ix = json.loads((tmp_path / "storms/index.json").read_text())
    ai = json.loads((tmp_path / "storms/history/all-index.json").read_text())
    assert list(ix["history"]) == ["NA", "WP", "SP"]
    assert [r["id"] for r in ai["basins"]] == ["NA", "WP", "SP"]


def test_one_failing_basin_does_not_stop_the_rest(tmp_path, monkeypatch):
    def load(basin, cache_dir=None):
        if basin == "WP":
            raise OSError("NCEI down")
        obs = fake_obs(basin)
        return obs, fake_storms(obs), ["IBTrACS"]

    monkeypatch.setattr(basins, "load_basin", load)
    assert cli.main(["--out", str(tmp_path), "--only", "history", "--basin", "NA,WP,SP"]) == 0
    ix = json.loads((tmp_path / "storms/index.json").read_text())
    assert list(ix["history"]) == ["NA", "SP"]


def test_old_ni_only_index_is_completed(tmp_path, patched):
    """An index written by the NI-only version gains the Round 2 fields without a rebuild."""
    assert cli.main(["--out", str(tmp_path), "--only", "history", "--basin", "NI"]) == 0
    p = tmp_path / "storms/index.json"
    ix = json.loads(p.read_text())
    for k in ("name", "file", "stats", "bytes", "gzip_bytes"):
        del ix["history"]["NI"][k]
    p.write_text(json.dumps(ix))
    assert cli.main(["--out", str(tmp_path), "--only", "history", "--basin", "WP"]) == 0
    ix = json.loads(p.read_text())
    assert validate_index(ix) == [] and ix["history"]["NI"]["bytes"] > 0


@pytest.mark.parametrize("basin", ["WP", "SP"])
def test_dateline_tracks_are_split_and_in_range(basin):
    obs = fake_obs(basin)
    coll, skipped = build_history(obs, fake_storms(obs), basin)
    assert skipped == [] and validate_history(coll, basin) == []
    geoms = [f["geometry"] for f in coll["features"]]
    assert all(g["type"] == "MultiLineString" for g in geoms)
    for g in geoms:
        assert len(g["coordinates"]) == 2
        for part in g["coordinates"]:
            assert len(part) >= 2
            assert all(-180 <= x <= 180 for x, _ in part)
            # no segment may span the map
            assert max(abs(np.diff([x for x, _ in part]))) < 100
        assert any(abs(abs(c[0]) - 180) < 1e-9 for c in iter_coords(g))


@pytest.mark.parametrize("basin", ["NA", "EP", "NI", "SI", "SA"])
def test_non_dateline_tracks_stay_whole(basin):
    obs = fake_obs(basin)
    coll, _ = build_history(obs, fake_storms(obs), basin)
    assert {f["geometry"]["type"] for f in coll["features"]} == {"LineString"}


def test_track_over_prime_meridian_is_not_split():
    obs = make_obs("SAx", [-10 + 2.0 * i for i in range(12)], [-20.0] * 12, basin="SA")
    coll, _ = build_history(obs, fake_storms(obs), "SA")
    assert coll["features"][0]["geometry"]["type"] == "LineString"


def test_stats_notes_are_honest_per_basin():
    for b in basins.BASINS:
        obs = fake_obs(b)
        s = build_stats(obs, b)
        n = s["notes"]
        assert s["basin"] == b and validate_stats(s) == []
        for needle in ("3-minute", "1-minute", "10-minute", "provisional", "Saffir-Simpson"):
            assert needle in n, (b, needle)
        assert "whatever `wind` the record carries" in n
        assert "before about 1980" in n or "before 20" in n
        assert basins.AGENCY_NOTES[b] in n
        assert s["monthly_period"][0] == 1980


def test_monthly_climatology_uses_satellite_era_only():
    old = make_obs("O", [80.0, 81.0, 82.0], [10.0] * 3, [40, 50, 60], "OLD", "NI", "1950-06-01")
    new = fake_obs("NI")
    obs = pd.concat([old, new], ignore_index=True)
    obs["year"] = obs["time"].dt.year
    s = build_stats(obs, "NI")
    assert sum(m["storms_per_year"] for m in s["monthly"]) < 3  # 1950 storm is excluded
    assert 6 not in [m["month"] for m in s["monthly"] if m["storms_per_year"] > 0]


# --- active job: global coverage and IBTrACS basin codes -----------------------

LINE = (
    "{b}, {cy:02d}, {t},   , BEST,   0, {lat:>4}, {lon:>5},  {w:>2}, 1000, TS,  34, NEQ,    0,    0,"
    "    0,    0, 1010,  160,  30,  40,   0,   L,   0,    ,   0,   0, {name:>9},  ,  0,    ,    0,"
    "    0,    0,    0, genesis-num, 016, "
)


def bdeck(b, cy, lat, lon, name):
    return "\n".join(
        LINE.format(b=b, cy=cy, t=t, lat=lat, lon=lon, w=45 + k * 5, name=name)
        for k, t in enumerate(("2025090112", "2025090118"))
    )


def test_active_covers_all_basins_with_ibtracs_codes(monkeypatch):
    decks = {
        "bal012025.dat": bdeck("AL", 1, "200N", "600W", "ALFA"),
        "bep022025.dat": bdeck("EP", 2, "150N", "1100W", "BRAVO"),
        "bcp032025.dat": bdeck("CP", 3, "150N", "1600W", "CHARLIE"),
        "bio042025.dat": bdeck("IO", 4, "150N", "0880E", "DELTA"),
        "bwp052025.dat": bdeck("WP", 5, "150N", "1700E", "ECHO"),
        "bsh062025.dat": bdeck("SH", 6, "150S", "0800E", "FOX"),  # South Indian
        "bsh072025.dat": bdeck("SH", 7, "150S", "1650E", "GOLF"),  # South Pacific
        "bsh082025.dat": bdeck("SH", 8, "250S", "0300W", "HOTEL"),  # South Atlantic
        "bsh092025.dat": bdeck("SH", 9, "150S", "1799W", "INDIA"),  # SP, west of dateline
        "bsh902025.dat": bdeck("SH", 90, "150S", "0800E", "INVEST"),  # invest, dropped
    }
    monkeypatch.setattr(
        st.realtime, "_list_mtimes", lambda base, timeout: dict.fromkeys(decks, pd.NaT)
    )
    monkeypatch.setattr(
        st.realtime, "_get", lambda url, timeout=60.0, retries=0: decks[url.rsplit("/", 1)[1]]
    )
    now = pd.Timestamp("2025-09-01 20:00")
    coll, rep = active.build_active(
        None,
        fetch_active_fn=lambda src, timeout: st.realtime.active_storms(src, now=now),
        fetch_forecast_fn=lambda s, src: (_ for _ in ()).throw(OSError("no forecast")),
    )
    assert validate_active(coll) == []
    pos = {
        f["properties"]["name"]: f["properties"]
        for f in coll["features"]
        if f["properties"]["kind"] == "position"
    }
    assert {n: p["basin"] for n, p in pos.items()} == {
        "ALFA": "NA",
        "BRAVO": "EP",
        "CHARLIE": "EP",
        "DELTA": "NI",
        "ECHO": "WP",
        "FOX": "SI",
        "GOLF": "SP",
        "HOTEL": "SA",
        "INDIA": "SP",
    }
    assert {p["agency"] for n, p in pos.items() if n in ("ALFA", "BRAVO", "CHARLIE")} == {"NHC"}
    assert {p["agency"] for n, p in pos.items() if n not in ("ALFA", "BRAVO", "CHARLIE")} == {
        "JTWC"
    }
    assert set(p["basin"] for p in pos.values()) <= set(basins.BASINS)


def test_partial_run_merges_into_the_published_index_in_a_stateless_runner(tmp_path):
    """A CI runner starts with an empty output dir: the previous index must come from the public URL."""
    import json
    import threading
    from functools import partial
    from http.server import HTTPServer, SimpleHTTPRequestHandler

    from storms_ingest.cli import _read_prev_index

    pub = tmp_path / "published"
    (pub / "storms").mkdir(parents=True)
    (pub / "storms" / "index.json").write_text(
        json.dumps({"schema": 1, "history": {"NI": {"count": 5}}, "active": {"count": 2}})
    )
    handler = partial(SimpleHTTPRequestHandler, directory=str(pub))
    handler.log_message = lambda *a, **k: None
    srv = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        empty = tmp_path / "scratch"
        empty.mkdir()
        base = f"http://127.0.0.1:{srv.server_port}"
        assert _read_prev_index(empty, base)["history"]["NI"]["count"] == 5
        assert _read_prev_index(empty, None) == {}  # no URL, no local file: fresh start
        assert (
            _read_prev_index(empty, base + "/nowhere") == {}
        )  # unreachable: fresh start, no crash
        (empty / "storms").mkdir()
        (empty / "storms" / "index.json").write_text(json.dumps({"history": {"WP": {}}}))
        assert "WP" in _read_prev_index(empty, base)["history"]  # a local file wins
    finally:
        srv.shutdown()
