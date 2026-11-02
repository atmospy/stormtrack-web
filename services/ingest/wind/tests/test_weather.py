import datetime as dt
import json
import os

import numpy as np
import pytest
from stormtrack_ingest_wind import encode, fields, fixtures, gfs, models, upload, verify, weather
from test_wind import FakeS3

UTC = dt.timezone.utc
RUN = dt.datetime(2026, 11, 1, 12, tzinfo=UTC)


@pytest.fixture
def world(monkeypatch):
    w = fixtures.FakeWorld(
        2.0, {("gfs", "2026110112"), ("ecmwf-ifs", "2026110112"), ("ecmwf-aifs", "2026110112")}
    )
    return w.install(monkeypatch)


def run_all(tmp_path, world, **kw):
    kw.setdefault("hours", 12)
    kw.setdefault("res", 4.0)
    return weather.ingest_all(
        str(tmp_path),
        list(models.MODELS.values()),
        fields.select(),
        runs={m: RUN for m in models.MODELS},
        **kw,
    )


def test_scalar_roundtrip_within_one_step():
    rng = np.random.default_rng(1)
    x = rng.uniform(930, 1070, (361, 720))
    png = encode.scalar_png(x, 930, 1070)
    rt = verify.roundtrip_scalar(png, x, 930, 1070)
    assert (
        rt["ok"]
        and rt["max_err"] <= 140 / 65535
        and rt["step"] == pytest.approx(0.002136, abs=1e-5)
    )
    # packing: R = hi byte, G = lo byte, B = 0, A = 255
    px = np.asarray(__import__("PIL.Image", fromlist=["x"]).open(__import__("io").BytesIO(png)))
    v16 = (px[..., 0].astype(int) << 8) | px[..., 1]
    assert (px[..., 2] == 0).all() and (px[..., 3] == 255).all()
    assert v16.max() <= 65535 and abs(v16[0, 0] - round((x[0, 0] - 930) / 140 * 65535)) == 0


def test_sqrt_encoding_matches_coordinator_definition():
    x = np.array([[0.0, 1.0, 25.0, 100.0, 250.0]])
    png = encode.scalar_png(x, 0, 100, "sqrt")
    px = np.asarray(__import__("PIL.Image", fromlist=["x"]).open(__import__("io").BytesIO(png)))
    v16 = (px[0, :, 0].astype(int) << 8) | px[0, :, 1]
    assert v16.tolist() == [0, 6554, 32768, 65535, 65535]  # sqrt(25)/sqrt(100) = 0.5
    back = encode.decode_scalar(png, 0, 100, "sqrt")
    assert np.allclose(back[0, :4], [0, 1, 25, 100], atol=0.01)


def test_precip_interval_and_gfs_cumulative_choice(world):
    gf = models.GFS()
    lst = gf.records(RUN, 6)
    off, ln = gf.locate(lst, ("APCP", "surface"))
    # last APCP record = running total (the first one is the resettable bucket)
    assert off == [o for o, v, _, _ in lst if v == "APCP"][-1]
    assert gf.locate(lst, ("TMP", "2 m above ground")) is not None
    c0, c3 = np.full((2, 2), 4.0), np.full((2, 2), 6.5)
    assert np.allclose(weather.precip_interval(c3, c0), 2.5)
    assert weather.precip_interval(c0, c3).min() == 0  # never negative


def test_units_conversion_and_refusal():
    from stormtrack_ingest_wind.grib import Msg

    z = np.zeros((2, 2), np.float32)

    def mk(u, v=1.0, step=0):
        return Msg(z + v, u, "x", "surface", 0, step, np.zeros(2), np.zeros(2), 1.0)

    assert models._convert(fields.BY_SLUG["mslp"], mk("Pa", 101325.0))[0, 0] == pytest.approx(
        1013.25
    )
    assert models._convert(fields.BY_SLUG["t2m"], mk("K", 273.15))[0, 0] == pytest.approx(
        0, abs=1e-4
    )
    assert models._convert(fields.BY_SLUG["precip"], mk("m", 0.002))[0, 0] == pytest.approx(2.0)
    assert models._convert(fields.BY_SLUG["precip"], mk("kg m**-2", 2.0))[0, 0] == 2.0
    with pytest.raises(ValueError):
        models._convert(fields.BY_SLUG["mslp"], mk("K"))
    with pytest.raises(ValueError):
        models._convert(fields.BY_SLUG["precip"], mk("m", step=3))


def test_field_selection():
    assert [f.slug for f in fields.select("wind", "10m,850")] == ["wind_10m", "wind_850"]
    assert [f.slug for f in fields.select("mslp,wind_250")] == ["mslp", "wind_250"]
    assert len(fields.select()) == 14
    assert [f.slug for f in fields.select("t,wind_10m")] == [
        f"t_{p}" for p in fields.PRESSURE_LEVELS
    ] + ["wind_10m"]
    assert [f.slug for f in fields.select("t", "500")] == ["t_500"]
    with pytest.raises(ValueError):
        fields.select("nope")
    with pytest.raises(ValueError):
        fields.parse_levels("123")


def test_valid_fhrs_per_model():
    a, i, g = models.AIFS(), models.IFS(), models.GFS()
    r00, r06 = RUN.replace(hour=0), RUN.replace(hour=6)
    assert a.valid_fhrs(r00, [0, 3, 6, 9, 12]) == [0, 6, 12]
    assert i.valid_fhrs(r06, [0, 3, 144, 150]) == [0, 3, 144]
    assert i.valid_fhrs(r00, [144, 147, 150]) == [144, 150]
    assert g.valid_fhrs(r00, [0, 3, 72]) == [0, 3, 72]


def test_full_tree_all_models(world, tmp_path):
    res = run_all(tmp_path, world)
    assert not res["errors"], res["errors"]
    idx = json.load(open(tmp_path / "weather" / "index.json"))
    assert idx["schema"] == 2 and [m["id"] for m in idx["models"]] == list(models.MODELS)
    assert "CC-BY-4.0" in idx["models"][1]["licence"] and "CC-BY-4.0" in idx["models"][2]["licence"]
    gfs_l = json.load(open(tmp_path / "weather" / "gfs" / "latest.json"))
    assert gfs_l["schema"] == 2 and gfs_l["run"] == "2026-11-01T12:00:00Z"
    assert [f["slug"] for f in gfs_l["fields"]] == [f.slug for f in fields.ALL_FIELDS]
    g = gfs_l["grid"]
    assert (g["width"], g["height"]) == (90, 46)
    for fld in gfs_l["fields"]:
        assert [f["fhr"] for f in fld["frames"]] == [0, 3, 6, 9, 12]
        for fr in fld["frames"]:
            assert os.path.getsize(tmp_path / fr["png"]) == fr["bytes"]
            assert fr["png"].startswith(f"weather/gfs/20261101T12/{fld['slug']}/f")
    p = next(f for f in gfs_l["fields"] if f["slug"] == "precip")
    assert p["transform"] == "sqrt" and p["range"] == [0.0, 100.0]
    # AIFS only publishes 6-hourly
    aifs = json.load(open(tmp_path / "weather" / "ecmwf-aifs" / "latest.json"))
    assert [f["fhr"] for f in aifs["fields"][0]["frames"]] == [0, 6, 12]
    # precip: frame 0 zeros, later frames = difference of cumulative totals, >= 0
    for mid in models.MODELS:
        lat = json.load(open(tmp_path / "weather" / mid / "latest.json"))
        pf = next(f for f in lat["fields"] if f["slug"] == "precip")
        a0 = encode.decode_scalar(
            open(tmp_path / pf["frames"][0]["png"], "rb").read(), 0, 100, "sqrt"
        )
        a1 = encode.decode_scalar(
            open(tmp_path / pf["frames"][1]["png"], "rb").read(), 0, 100, "sqrt"
        )
        assert a0.max() == 0 and a1.max() > 0 and a1.min() >= 0
        assert pf["frames"][1]["interval_h"] == pf["frames"][1]["fhr"]
    # ECMWF grid starts at 180E: orientation must still be north-first, -180..180 (mslp ~ lat band)
    m = verify.plausibility
    for mid in models.MODELS:
        lat = json.load(open(tmp_path / "weather" / mid / "latest.json"))
        mf = next(f for f in lat["fields"] if f["slug"] == "mslp")
        x = encode.decode_scalar(open(tmp_path / mf["frames"][0]["png"], "rb").read(), 930, 1070)
        assert m("mslp", 0, x=x)["ok"]

    # IFS and GFS fixtures share physics, so the same field must agree after the 180E roll
    def load(mid):
        lat = json.load(open(tmp_path / "weather" / mid / "latest.json"))
        mf = next(f for f in lat["fields"] if f["slug"] == "t2m")
        return encode.decode_scalar(open(tmp_path / mf["frames"][0]["png"], "rb").read(), -60, 60)

    assert np.abs(load("gfs") - load("ecmwf-ifs")).max() < 0.01


def test_legacy_wind_identical_to_v2(world, tmp_path):
    run_all(tmp_path, world)
    v1 = json.load(open(tmp_path / "wind" / "latest.json"))
    assert v1["schema"] == 1 and v1["image"]["speed_max"] == 70 and v1["level"] == "10m"
    for fr in v1["frames"]:
        old = open(tmp_path / fr["png"], "rb").read()
        new = open(
            tmp_path / fr["png"].replace("wind/", "weather/gfs/").replace("/f", "/wind_10m/f"), "rb"
        ).read()
        assert old == new


def test_idempotent_resumable_and_prune(world, tmp_path):
    for old in ("20261030T00", "20261031T00", "20261031T12"):
        os.makedirs(tmp_path / "weather" / "gfs" / old)
    run_all(tmp_path, world)
    assert sorted(os.listdir(tmp_path / "weather" / "gfs")) == [
        "20261031T12",
        "20261101T12",
        "latest.json",
    ]
    n = len(world.gets)
    os.remove(tmp_path / "weather/gfs/20261101T12/mslp/f006.png")
    run_all(tmp_path, world)
    assert len(world.gets) > n  # refetched the missing frame only
    assert len(world.gets) - n <= 2
    assert all(r is not None for _, r in world.gets)  # never a full-file GET
    assert not [p for _, _, fs in os.walk(tmp_path) for p in fs if ".tmp" in p]


def test_latest_complete_run_fallback(world, tmp_path):
    world.avail = {("ecmwf-ifs", "2026110100")}  # only the older cycle exists
    r = models.IFS().find_latest_run(dt.datetime(2026, 11, 1, 20, tzinfo=UTC), 12, 3)
    assert (r.day, r.hour) == (1, 0)
    world.avail = set()
    with pytest.raises(RuntimeError):
        models.AIFS().find_latest_run(dt.datetime(2026, 11, 1, 20, tzinfo=UTC), 12, 3)


def test_failing_model_does_not_block_others(world, tmp_path):
    world.avail.discard(("ecmwf-ifs", "2026110112"))
    res = run_all(tmp_path, world)
    assert "ecmwf-ifs" in res["errors"] and set(res["models"]) == {"gfs", "ecmwf-aifs"}
    idx = json.load(open(tmp_path / "weather" / "index.json"))
    assert [m["id"] for m in idx["models"]] == ["gfs", "ecmwf-aifs"]


def test_missing_field_is_omitted_not_fabricated(world, tmp_path, monkeypatch):
    orig = models.IFS.locate
    monkeypatch.setattr(
        models.IFS,
        "locate",
        lambda self, lst, key: None if key[0] == "msl" else orig(self, lst, key),
    )
    res = run_all(tmp_path, world)
    assert "mslp" not in [f["slug"] for f in res["models"]["ecmwf-ifs"]["fields"]]
    assert "mslp" in [f["slug"] for f in res["models"]["gfs"]["fields"]]


def test_dry_run_and_upper_step(world, tmp_path):
    assert run_all(tmp_path, world, dry_run=True)["models"] == {}
    assert os.listdir(tmp_path) == []
    res = run_all(tmp_path, world, hours=12, upper_step=6)
    f = {x["slug"]: x for x in res["models"]["gfs"]["fields"]}
    assert [x["fhr"] for x in f["wind_500"]["frames"]] == [0, 6, 12]
    assert [x["fhr"] for x in f["mslp"]["frames"]] == [0, 3, 6, 9, 12]


def test_verify_tree_passes_on_fixture_data(world, tmp_path, capsys):
    run_all(tmp_path, world)
    # fixture winds are not meteorologically real (no 60 m/s jet): only structure is checked here
    assert verify.verify_tree(str(tmp_path), "gfs", {0, 6}) >= 0
    assert "mslp" in capsys.readouterr().out


def test_plausibility_detects_bad_data():
    bad = np.full((46, 90), 1100.0)
    assert not verify.plausibility("mslp", 3, x=bad)["ok"]
    assert not verify.plausibility("precip", 3, x=np.full((46, 90), -1.0))["ok"]
    assert not verify.plausibility("precip", 0, x=np.full((46, 90), 1.0))["ok"]
    assert not verify.plausibility("t2m", 0, x=np.full((46, 90), 15.0))["ok"]


def test_upload_all_order_headers_merge(world, tmp_path):
    res = run_all(tmp_path, world)
    s3 = FakeS3()
    s3.objs["p/weather/index.json"] = (
        json.dumps(
            {"models": [{"id": "other", "name": "x", "licence": "", "run": "", "latest": ""}]}
        ).encode(),
        {},
    )
    s3.get_object = lambda Bucket, Key: {"Body": __import__("io").BytesIO(s3.objs[Key][0])}
    s3.head_object = lambda Bucket, Key: (_ for _ in ()).throw(KeyError(Key))
    for old in ("20261029T00", "20261030T00"):
        s3.objs[f"p/weather/gfs/{old}/mslp/f000.png"] = (b"x", {})
    n = upload.upload_all(s3, "b", str(tmp_path), res, prefix="p", keep=2)
    assert n > 100 and s3.calls[-1] == "p/weather/index.json"  # catalogue LAST
    png = s3.objs["p/weather/gfs/20261101T12/mslp/f000.png"][1]
    assert png["ContentType"] == "image/png" and "immutable" in png["CacheControl"]
    for k in ("p/weather/gfs/latest.json", "p/weather/index.json", "p/wind/latest.json"):
        assert s3.objs[k][1]["CacheControl"] == "public, max-age=60"
    i_gfs = s3.calls.index("p/weather/gfs/latest.json")
    assert all(i < i_gfs for i, k in enumerate(s3.calls) if k.startswith("p/weather/gfs/2026"))
    merged = json.loads(s3.objs["p/weather/index.json"][0])
    assert [m["id"] for m in merged["models"]] == ["gfs", "ecmwf-ifs", "ecmwf-aifs", "other"]
    assert not any(k.startswith("p/weather/gfs/20261029T00") for k in s3.objs)


@pytest.mark.network
def test_real_ecmwf_layout_and_gfs_fields(tmp_path):
    now = dt.datetime.now(UTC)
    for m in models.MODELS.values():
        run = m.find_latest_run(now, 6, 3)
        specs = m.available_specs(run, 6, fields.select())
        assert len(specs) == 9, (m.id, [s.slug for s in specs])
        got = m.fetch(run, 6, [fields.BY_SLUG[s] for s in ("mslp", "wind_250", "precip")])
        assert 940 < got["mslp"].u.mean() < 1030 and got["precip"].u.min() >= 0
        assert gfs.run_id(run)


def test_ecmwf_base_prefers_first_working_mirror(monkeypatch):
    run = dt.datetime(2026, 11, 2, 0)
    monkeypatch.delenv("ECMWF_BASE", raising=False)
    models._BASE_CHOSEN.clear()
    seen = []

    def fake_get(url, byte_range=None, timeout=60, tries=20):
        seen.append(url)
        if "data.ecmwf.int" in url:
            raise IOError("HTTP Error 503")
        return b"x" * 256

    monkeypatch.setattr(models.http, "get", fake_get)
    base = models.ecmwf_base(run, "ifs/0p25/oper")
    assert base == "https://storage.googleapis.com/ecmwf-open-data"  # ECMWF failed, Google answered
    assert len(seen) == 2
    models.ecmwf_base(run, "ifs/0p25/oper")  # decided once per run
    assert len(seen) == 2
    models._BASE_CHOSEN.clear()


def test_ecmwf_base_env_override_and_all_failing(monkeypatch):
    run = dt.datetime(2026, 11, 2, 0)
    models._BASE_CHOSEN.clear()
    monkeypatch.setenv("ECMWF_BASE", "https://example.test/x/")
    assert models.ecmwf_base(run, "ifs/0p25/oper") == "https://example.test/x"
    monkeypatch.delenv("ECMWF_BASE")

    def boom(url, byte_range=None, timeout=60, tries=20):
        raise IOError("down")

    monkeypatch.setattr(models.http, "get", boom)
    assert (
        models.ecmwf_base(run, "ifs/0p25/oper") == models.ECMWF_BASES[0]
    )  # nothing answered: first, retries report
    models._BASE_CHOSEN.clear()


def test_ecmwf_base_not_published_yet_is_not_cached(monkeypatch):
    run = dt.datetime(2026, 11, 2, 12)
    models._BASE_CHOSEN.clear()
    monkeypatch.delenv("ECMWF_BASE", raising=False)
    calls = []

    def missing(url, byte_range=None, timeout=60, tries=20):
        calls.append(url)
        raise models.http.NotFound(url)

    monkeypatch.setattr(models.http, "get", missing)
    assert models.ecmwf_base(run, "ifs/0p25/oper") == models.ECMWF_BASES[0]
    assert len(calls) == 1  # one 404 is enough: no point trying the other mirrors
    assert (run, "ifs/0p25/oper") not in models._BASE_CHOSEN
