import pandas as pd
from fastapi.testclient import TestClient
from stormtrack_api import service
from stormtrack_api.app import create_app


class BT:
    def __init__(self, obs):
        self.observations = obs


def obs(sid, winds, name="TESTY", start="2026-10-30 00:00", year=2026):
    n = len(winds)
    t = pd.date_range(start, periods=n, freq="6h")
    return pd.DataFrame(
        {
            "storm_id": sid,
            "year": year,
            "name": name,
            "basin": "NI",
            "time": t,
            "lat": [10 + i for i in range(n)],
            "lon": [80 + i for i in range(n)],
            "wind": winds,
            "pressure": [1000 - w / 2 for w in winds],
        }
    )


def make(calls=None):
    live = obs("IO042026", [35, 40, 60, 70, 90, 100], name="MURASU")
    hist = pd.concat(
        [
            obs(
                "1999298N12099",
                [30, 60, 100, 140, 120, 80],
                name=None,
                year=1999,
                start="1999-10-25 00:00",
            )
        ]
    )

    def fetch(src):
        if calls is not None:
            calls.append(src)
        if src == "nhc":
            return BT(pd.DataFrame(columns=live.columns))
        return BT(live)

    return create_app(fetch_active=fetch, load_history=lambda: hist)


def test_health():
    assert TestClient(make()).get("/healthz").json() == {"status": "ok"}


def test_active_and_cache():
    calls = []
    c = TestClient(make(calls))
    r = c.get("/v1/storms/active")
    assert r.status_code == 200
    f = r.json()["features"]
    assert (
        len(f) == 1
        and f[0]["properties"]["category"]["label"] == "C3"
        and f[0]["properties"]["wind_period_min"] == 1
    )
    n = len(calls)
    c.get("/v1/storms/active")
    assert len(calls) == n  # served from the in-memory cache


def test_active_survives_source_failure():
    def fetch(src):
        if src == "nhc":
            raise OSError("down")
        return BT(obs("IO042026", [35, 40]))

    r = (
        TestClient(create_app(fetch_active=fetch, load_history=lambda: pd.DataFrame()))
        .get("/v1/storms/active")
        .json()
    )
    assert r["failed"] == {"NHC": "OSError"} and r["sources"] == ["JTWC"]


def test_summary_historical_and_active():
    c = TestClient(make())
    h = c.get("/v1/storms/1999298N12099/summary").json()
    assert (
        h["peak"]["wind_kt"] == 140
        and h["peak"]["category"] == "C5"
        and h["rapid_intensification"] is True
        and h["ace"] > 0
    )
    a = c.get("/v1/storms/IO042026/summary").json()
    assert a["peak"]["category"] == "C3" and a["wind_period_min"] == 1 and a["name"] == "MURASU"


def test_summary_404_and_validation():
    c = TestClient(make())
    assert c.get("/v1/storms/NOPE123/summary").status_code == 404
    assert c.get("/v1/storms/..%2Fx/summary").status_code in (404, 422)


def test_cors(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://app.example.com")
    c = TestClient(make())
    ok = c.get("/healthz", headers={"Origin": "https://app.example.com"})
    assert ok.headers["access-control-allow-origin"] == "https://app.example.com"
    bad = c.get("/healthz", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in bad.headers
    monkeypatch.delenv("CORS_ORIGINS")
    assert (
        "access-control-allow-origin"
        not in TestClient(make())
        .get("/healthz", headers={"Origin": "https://app.example.com"})
        .headers
    )


def test_category_thresholds():
    assert [service.category(w) for w in (33, 34, 63, 64, 82, 83, 95, 96, 112, 113, 136, 137)] == [
        "TD",
        "TS",
        "TS",
        "C1",
        "C1",
        "C2",
        "C2",
        "C3",
        "C3",
        "C4",
        "C4",
        "C5",
    ]
