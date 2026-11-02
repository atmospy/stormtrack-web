"""Offline end-to-end check: synthetic GRIB2 -> decode -> resample -> PNG -> decode -> compare."""

from __future__ import annotations

import logging

import numpy as np

from . import encode, fixtures, grib, grid, verify

log = logging.getLogger("stormtrack.wind")


def run_selftest() -> int:
    d = 2.0
    raw = fixtures.grib_uv(d)
    f = grib.decode_uv(raw)
    assert f.lons[0] == -180 and f.lons[-1] == 180 - d, "longitude roll failed"
    assert f.lats[0] == 90 and f.lats[-1] == -90, "latitude order"
    _, lons0, u0, v0 = fixtures.synthetic_fields(d)
    exp = np.roll(u0, -int(np.where(lons0 >= 180)[0][0]), axis=1)
    assert np.abs(f.u - exp).max() < 1e-3, "decoded U != fixture"
    u, v, g = grid.resample(f, 4.0)
    png = encode.png_bytes(u, v)
    rt = verify.roundtrip_error(png, u, v)
    log.info("selftest: grid %dx%d, png %d B, roundtrip %s", g.width, g.height, len(png), rt)
    assert rt["ok"], rt
    sn = verify.sanity(u, v)
    log.info("selftest sanity: %s", sn)
    _selftest_weather()
    print("selftest OK")
    return 0


def _selftest_weather() -> None:
    """All three models x all fields through a mocked bucket into a temp dir (no network)."""
    import datetime as dt
    import tempfile

    from . import fields, http, models, weather

    world = fixtures.FakeWorld(2.0, {(m, "2026110112") for m in models.MODELS})
    run = dt.datetime(2026, 11, 1, 12, tzinfo=dt.timezone.utc)
    saved = http.get, http.head
    http.get, http.head = world.get, world.head
    try:
        with tempfile.TemporaryDirectory() as tmp:
            res = weather.ingest_all(
                tmp,
                list(models.MODELS.values()),
                fields.select(),
                runs={m: run for m in models.MODELS},
                hours=6,
                res=4.0,
            )
            assert not res["errors"], res["errors"]
            assert verify.verify_tree(tmp, "gfs", {0, 6}) >= 0
            log.info("selftest weather: %s", sorted(res["models"]))
    finally:
        http.get, http.head = saved
