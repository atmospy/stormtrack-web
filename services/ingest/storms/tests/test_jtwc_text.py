from datetime import datetime, timezone
from pathlib import Path

import pytest
from storms_ingest import jtwc_text as j
from storms_ingest.active import PROXY_NOTE, forecast_features

FIX = Path(__file__).parent / "fixtures" / "jtwc_wp3026_warning040.txt"
NOW = datetime(2026, 11, 2, 9, tzinfo=timezone.utc)


def test_text_name():
    assert j.text_name("WP302026") == "wp3026"
    assert j.text_name("IO042026") == "io0426"
    assert j.text_name("SH012026") == "sh0126"
    assert j.text_name("AL012026") is None  # NHC basins have no JTWC text


def test_parse_warning_positions_and_winds():
    df = j.parse_warning(FIX.read_text(), NOW)
    assert list(df["tau"]) == [0, 12, 24, 36, 48, 60, 72, 96]
    assert (df["lat"].iloc[0], df["lon"].iloc[0]) == (22.6, 140.9)  # warning position 020600Z
    assert (df["lat"].iloc[-1], df["lon"].iloc[-1]) == (38.2, 152.0)  # 96 h
    assert list(df["vmax"])[:3] == [70.0, 70.0, 75.0]
    assert str(df["init"].iloc[0]) == "2026-11-02 06:00:00"
    assert set(df["tech"]) == {"JTWC"}


def test_month_rollover():
    txt = FIX.read_text().replace("020900", "010100").replace("020600Z", "312100Z")
    df = j.parse_warning(txt, datetime(2026, 11, 1, 1, tzinfo=timezone.utc))
    assert str(df["init"].iloc[0]) == "2026-10-31 21:00:00"


def test_rejects_non_warning():
    with pytest.raises(ValueError):
        j.parse_warning("<html>404</html>", NOW)


def test_jtwc_cone_is_labelled_proxy():
    df = j.parse_warning(FIX.read_text(), NOW)
    radii = {
        "radii_km": {12: 40.0, 24: 70.0, 36: 100.0, 48: 130.0, 72: 200.0, 96: 280.0},
        "basis": "NHC basis.",
    }
    feats = forecast_features("WP302026", df, radii, proxy=True)
    cone = next(f for f in feats if f["properties"]["kind"] == "cone")
    assert cone["properties"]["proxy"] is True
    assert cone["properties"]["basis"].startswith(PROXY_NOTE)
    nhc = next(
        f for f in forecast_features("AL012026", df, radii) if f["properties"]["kind"] == "cone"
    )
    assert "proxy" not in nhc["properties"]


def test_newer_warning_position_becomes_the_latest_fix():
    import pandas as pd
    from storms_ingest.active import latest_warning_fix

    obs = pd.DataFrame(
        {
            "storm_id": ["WP302026"] * 2,
            "time": pd.to_datetime(["2026-11-02 00:00", "2026-11-02 06:00"]),
            "lat": [22.4, 22.6],
            "lon": [141.8, 140.9],
            "wind": [70.0, 70.0],
            "pressure": [960.0, 958.0],
            "name": ["IN-FA"] * 2,
            "basin": ["WP"] * 2,
        }
    )
    fc = pd.DataFrame(
        {
            "init": pd.to_datetime(["2026-11-02 12:00"] * 2),
            "tau": [0, 12],
            "lat": [23.0, 23.4],
            "lon": [140.2, 139.0],
            "vmax": [65.0, 60.0],
            "tech": ["JTWC"] * 2,
        }
    )
    out = latest_warning_fix(obs, fc)
    assert len(out) == 3 and out.iloc[-1]["time"] == pd.Timestamp("2026-11-02 12:00")
    assert (out.iloc[-1]["lat"], out.iloc[-1]["lon"], out.iloc[-1]["wind"]) == (23.0, 140.2, 65.0)
    assert pd.isna(out.iloc[-1]["pressure"]) and out.iloc[-1]["name"] == "IN-FA"
    # an older or equal warning, no forecast, or no lead-time-0 row leaves the observations alone
    assert len(latest_warning_fix(obs, fc.assign(init=pd.Timestamp("2026-11-02 06:10")))) == 2
    assert latest_warning_fix(obs, None) is obs
    assert len(latest_warning_fix(obs, fc[fc["tau"] > 0])) == 2
