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
    k = int(np.argmin(np.abs(((lons0 + 180) % 360) - 180 - f.lons[0])))
    exp = np.roll(u0, -int(np.where(lons0 >= 180)[0][0]), axis=1)
    assert np.abs(f.u - exp).max() < 1e-3, "decoded U != fixture"
    u, v, g = grid.resample(f, 4.0)
    png = encode.png_bytes(u, v)
    rt = verify.roundtrip_error(png, u, v)
    log.info("selftest: grid %dx%d, png %d B, roundtrip %s", g.width, g.height, len(png), rt)
    assert rt["ok"], rt
    sn = verify.sanity(u, v)
    log.info("selftest sanity: %s", sn)
    print("selftest OK")
    return 0
