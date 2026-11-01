"""Build tiny synthetic GRIB2 10u/10v messages (GFS-like layout: 0..360 lon, north first)."""
from __future__ import annotations

import numpy as np


def synthetic_fields(d: float = 2.0):
    nlat, nlon = int(180 / d) + 1, int(360 / d)
    lats = 90 - d * np.arange(nlat)
    lons = d * np.arange(nlon)  # 0..360
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    # westerlies mid-lat, easterlies tropics, plus longitude wave; v meridional
    u = np.where(np.abs(LA) < 30, -6 + 0 * LA, 10) + 3 * np.cos(np.radians(LO))
    v = 5 * np.sin(np.radians(LO * 2)) * np.cos(np.radians(LA))
    return lats, lons, u.astype(np.float64), v.astype(np.float64)


def _msg(name: str, vals: np.ndarray, d: float) -> bytes:
    import eccodes

    h = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    nlat, nlon = vals.shape
    for k, v in [("Ni", nlon), ("Nj", nlat), ("latitudeOfFirstGridPointInDegrees", 90.0),
                 ("longitudeOfFirstGridPointInDegrees", 0.0),
                 ("latitudeOfLastGridPointInDegrees", -90.0),
                 ("longitudeOfLastGridPointInDegrees", 360.0 - d),
                 ("iDirectionIncrementInDegrees", d), ("jDirectionIncrementInDegrees", d),
                 ("jScansPositively", 0), ("bitsPerValue", 16), ("packingType", "grid_complex_spatial_differencing"),
                 ("discipline", 0), ("parameterCategory", 2),
                 ("parameterNumber", 2 if name == "10u" else 3),
                 ("typeOfFirstFixedSurface", 103), ("scaleFactorOfFirstFixedSurface", 0),
                 ("scaledValueOfFirstFixedSurface", 10)]:
        eccodes.codes_set(h, k, v)
    eccodes.codes_set_values(h, vals.ravel())
    out = eccodes.codes_get_message(h)
    eccodes.codes_release(h)
    return bytes(out)


def grib_uv(d: float = 2.0) -> bytes:
    _, _, u, v = synthetic_fields(d)
    return _msg("10u", u, d) + _msg("10v", v, d)


def fake_idx(msgs: bytes, n_before: int = 3000) -> tuple:
    """-> (full_file_bytes, idx_text) with filler records before/after the U/V pair."""
    from .grib import split_messages

    u, v = split_messages(msgs)
    pre, post = b"P" * n_before, b"Q" * 500
    body = pre + u + v + post
    lines = [f"1:0:d=2026110106:TMP:2 m above ground:anl:",
             f"2:{n_before}:d=2026110106:UGRD:10 m above ground:anl:",
             f"3:{n_before + len(u)}:d=2026110106:VGRD:10 m above ground:anl:",
             f"4:{n_before + len(u) + len(v)}:d=2026110106:ICEG:10 m above mean sea level:anl:"]
    return body, "\n".join(lines) + "\n"
