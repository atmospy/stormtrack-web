from pathlib import Path

import pandas as pd
import pytest

FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def bdeck():
    from stormtrack.atcf import best_track_frame, parse_atcf

    return best_track_frame(parse_atcf((FIX / "bal052025.dat").read_text()))


@pytest.fixture
def ofcl_deck():
    from stormtrack.atcf import parse_atcf

    return parse_atcf((FIX / "aal052025_ofcl.dat").read_text())


@pytest.fixture
def fst_mid():
    from stormtrack.atcf import parse_atcf

    return parse_atcf((FIX / "fst_mid.dat").read_text())


def make_obs(
    sid, lons, lats, winds=None, name="TESTY", basin="NI", start="2026-10-30 00:00", step_h=6
):
    n = len(lons)
    t = pd.date_range(start, periods=n, freq=f"{step_h}h")
    return pd.DataFrame(
        {
            "storm_id": sid,
            "year": t[0].year,
            "serial": 1,
            "basin": basin,
            "name": name,
            "time": t,
            "lon": lons,
            "lat": lats,
            "wind": winds if winds is not None else [30.0 + 5 * i for i in range(n)],
            "pressure": [1000.0 - i for i in range(n)],
            "ty": "TS",
            "step": range(n),
        }
    )
