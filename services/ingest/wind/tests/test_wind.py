import datetime as dt
import json
import os

import numpy as np
import pytest
from PIL import Image
from stormtrack_ingest_wind import encode, fixtures, gfs, grib, grid, pipeline, upload, verify

UTC = dt.timezone.utc


def test_idx_ranges_merge_and_exact():
    idx = gfs.parse_idx(
        "1:0:d=x:TMP:2 m above ground:anl:\n2:100:d=x:UGRD:10 m above ground:anl:\n"
        "3:300:d=x:VGRD:10 m above ground:anl:\n4:450:d=x:ICEG:10 m above mean sea level:anl:\n"
    )
    assert gfs.uv_ranges(idx) == [(100, 449)]
    idx2 = gfs.parse_idx(
        "1:100:d=x:UGRD:10 m above ground:anl:\n2:150:d=x:FOO:x:anl:\n"
        "3:300:d=x:VGRD:10 m above ground:anl:\n"
    )
    assert gfs.uv_ranges(idx2) == [(100, 149), (300, None)]


def test_candidate_runs():
    c = gfs.candidate_runs(dt.datetime(2026, 11, 1, 14, 16, tzinfo=UTC))
    assert c[0].hour == 12 and c[1].hour == 6 and c[1].day == 1 and c[2].hour == 0


def test_decode_longitude_roll_and_orientation():
    f = grib.decode_uv(fixtures.grib_uv(2.0))
    assert f.lons[0] == -180 and f.lons[-1] == 178 and f.lats[0] == 90 and f.lats[-1] == -90
    _, lons0, u0, _ = fixtures.synthetic_fields(2.0)
    # lon 0 column of source must land at lon 0 column of output
    j_out = int(np.where(f.lons == 0)[0][0])
    assert np.allclose(f.u[:, j_out], u0[:, 0], atol=1e-3)
    # lon 180 (source col 90) -> -180 (out col 0)
    assert np.allclose(f.u[:, 0], u0[:, 90], atol=1e-3)


@pytest.mark.parametrize("method", ["nearest", "mean"])
def test_resample_shape_and_grid(method):
    f = grib.decode_uv(fixtures.grib_uv(2.0))
    u, v, g = grid.resample(f, 4.0, method)
    assert u.shape == (46, 90) and (g.lon_left, g.lat_top, g.lat_bottom) == (-180, 90, -90)
    with pytest.raises(ValueError):
        grid.resample(f, 3.0)


def test_nearest_is_every_nth():
    f = grib.decode_uv(fixtures.grib_uv(2.0))
    u, _, _ = grid.resample(f, 4.0)
    assert np.array_equal(u, f.u[::2, ::2])


def test_png_contract_and_roundtrip():
    rng = np.random.default_rng(0)
    u = rng.uniform(-60, 60, (361, 720)).astype(np.float32)
    v = rng.uniform(-60, 60, (361, 720)).astype(np.float32)
    data = encode.png_bytes(u, v)
    im = Image.open(__import__("io").BytesIO(data))
    assert im.mode == "RGBA" and im.size == (720, 361)
    assert not {"gamma", "icc_profile", "srgb"} & set(im.info)
    assert b"gAMA" not in data and b"iCCP" not in data and b"sRGB" not in data
    assert (np.asarray(im)[..., 3] == 255).all()
    rt = verify.roundtrip_error(data, u, v)
    assert rt["ok"] and rt["u"] <= 0.2
    # exact formula spot checks
    px = encode.to_rgba(np.array([[0.0, -50.0, 50.0]]), np.array([[0.0, 0.0, 0.0]]))[0]
    assert px[0].tolist()[:1] == [128] or px[0][0] == round(50 / 100 * 255)
    assert px[1][0] == 0 and px[2][0] == 255 and px[2][2] == round(50 / 70 * 255)


def test_sanity_detects_bad_sign():
    u = np.full((361, 720), 1.0, dtype=np.float32)
    assert not verify.sanity(u, u)["ok"]


def test_pipeline_end_to_end_idempotent_prune(fake_noaa, tmp_path):
    out = str(tmp_path)
    run = dt.datetime(2026, 11, 1, 6, tzinfo=UTC)
    # pre-existing old runs: only newest 2 survive
    for old in ("20261031T00", "20261031T06", "20261031T12"):
        os.makedirs(tmp_path / "wind" / old)
    lat = pipeline.ingest(out, run=run, hours=12, step=3, res=4.0)
    assert [f["fhr"] for f in lat["frames"]] == [0, 3, 6, 9, 12]
    assert (
        lat["run"] == "2026-11-01T06:00:00Z" and lat["frames"][1]["valid"] == "2026-11-01T09:00:00Z"
    )
    assert lat["image"]["width"] == 90 and lat["image"]["lon_right"] == 176
    disk = json.load(open(tmp_path / "wind" / "latest.json"))
    assert disk == lat and disk["frames"][0]["png"] == "wind/20261101T06/f000.png"
    assert disk["frames"][0]["bytes"] == os.path.getsize(tmp_path / disk["frames"][0]["png"])
    assert sorted(os.listdir(tmp_path / "wind")) == ["20261031T12", "20261101T06", "latest.json"]
    # only Range requests on the big object, never a full GET
    assert all(r is not None for url, r in fake_noaa["gets"] if not url.endswith(".idx"))
    n = len(fake_noaa["gets"])
    pipeline.ingest(out, run=run, hours=12, step=3, res=4.0)  # idempotent: no new data gets
    assert len(fake_noaa["gets"]) == n
    assert not [p for p in os.listdir(tmp_path / "wind") if ".tmp" in p]


def test_falls_back_to_previous_run(fake_noaa):
    fake_noaa["avail"] = {"20261101/00"}
    r = gfs.find_latest_run(dt.datetime(2026, 11, 1, 8, tzinfo=UTC), [0, 3, 72])
    assert r.hour == 0 and r.day == 1


def test_no_run_raises(fake_noaa):
    fake_noaa["avail"] = set()
    with pytest.raises(RuntimeError):
        gfs.find_latest_run(dt.datetime(2026, 11, 1, 8, tzinfo=UTC), [0])


def test_dry_run_writes_nothing(fake_noaa, tmp_path):
    assert (
        pipeline.ingest(
            str(tmp_path),
            run=dt.datetime(2026, 11, 1, 6, tzinfo=UTC),
            hours=3,
            step=3,
            res=4.0,
            dry_run=True,
        )
        is None
    )
    assert os.listdir(tmp_path) == []


class FakeS3:
    def __init__(self):
        self.objs, self.calls = {}, []

    def put_object(self, Bucket, Key, Body, **kw):
        self.calls.append(Key)
        self.objs[Key] = (Body, kw)

    def list_objects_v2(self, Bucket, Prefix, Delimiter=None):
        if Delimiter:
            ps = sorted(
                {
                    Prefix + k[len(Prefix) :].split("/")[0] + "/"
                    for k in self.objs
                    if k.startswith(Prefix) and "/" in k[len(Prefix) :]
                }
            )
            return {"CommonPrefixes": [{"Prefix": p} for p in ps]}
        return {"Contents": [{"Key": k} for k in self.objs if k.startswith(Prefix)]}

    def delete_objects(self, Bucket, Delete):
        for o in Delete["Objects"]:
            self.objs.pop(o["Key"], None)


def test_upload_order_prune_headers(fake_noaa, tmp_path):
    run = dt.datetime(2026, 11, 1, 6, tzinfo=UTC)
    lat = pipeline.ingest(str(tmp_path), run=run, hours=3, step=3, res=4.0)
    s3 = FakeS3()
    for old in ("20261030T00", "20261031T00", "20261031T06"):
        s3.objs[f"p/wind/{old}/f000.png"] = (b"x", {})
    n = upload.upload_run(s3, "b", str(tmp_path), lat, prefix="p", keep=2)
    assert n == 3 and s3.calls[-1] == "p/wind/latest.json"  # pointer last
    assert s3.objs["p/wind/20261101T06/f000.png"][1]["ContentType"] == "image/png"
    assert "immutable" in s3.objs["p/wind/20261101T06/f000.png"][1]["CacheControl"]
    assert (
        "p/wind/20261030T00/f000.png" not in s3.objs
        and "p/wind/20261031T00/f000.png" not in s3.objs
    )
    assert "p/wind/20261031T06/f000.png" in s3.objs


def test_upload_requires_env():
    with pytest.raises(SystemExit):
        upload.client_from_env({})


def test_selftest():
    from stormtrack_ingest_wind.selftest import run_selftest

    assert run_selftest() == 0


@pytest.mark.network
def test_real_gfs_one_frame(tmp_path):
    """Real NOAA bucket: latest run f000, byte-range only, ~2 MB download, full verification."""
    from stormtrack_ingest_wind import http

    now = dt.datetime.now(UTC)
    run = gfs.find_latest_run(now, [0])
    http.STATS.update(bytes=0, requests=0)
    raw = gfs.fetch_uv(run, 0)
    assert len(raw) < 3_000_000
    f = grib.decode_uv(raw)
    u, v, g = grid.resample(f, 0.5)
    assert (g.width, g.height) == (720, 361)
    png = encode.png_bytes(u, v)
    assert len(png) <= 400_000
    assert verify.roundtrip_error(png, u, v)["ok"]
    assert verify.sanity(u, v)["ok"]
