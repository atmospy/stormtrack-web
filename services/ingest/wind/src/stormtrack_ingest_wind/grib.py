"""Decode GFS 10 m U/V (GRIB2 template 5.3 complex packing + spatial differencing) via ECMWF eccodes.

Output is normalised to: north-first rows, longitudes -180..180 ascending.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Dict, List

import warnings

import numpy as np

# the bundled libeccodes can trail the python bindings; the warning is cosmetic
warnings.filterwarnings("ignore", message="ecCodes .* or higher is recommended")


@dataclass
class Field:
    u: np.ndarray  # (nlat, nlon) float32 m/s, row 0 = north
    v: np.ndarray
    lats: np.ndarray
    lons: np.ndarray  # -180..180 ascending
    d: float  # source spacing, degrees


def split_messages(buf: bytes) -> List[bytes]:
    out, p = [], 0
    while p < len(buf):
        if buf[p:p + 4] != b"GRIB":
            raise ValueError(f"bad GRIB magic at {p}")
        n = struct.unpack(">Q", buf[p + 8:p + 16])[0]
        out.append(buf[p:p + n])
        p += n
    return out


def _decode_one(msg: bytes):
    import eccodes

    h = eccodes.codes_new_from_message(msg)
    try:
        g = lambda k: eccodes.codes_get(h, k)  # noqa: E731
        ni, nj = g("Ni"), g("Nj")
        vals = np.asarray(eccodes.codes_get_values(h), dtype=np.float64).reshape(nj, ni)
        lat0 = g("latitudeOfFirstGridPointInDegrees")
        lon0 = g("longitudeOfFirstGridPointInDegrees")
        di = g("iDirectionIncrementInDegrees")
        dj = g("jDirectionIncrementInDegrees")
        name = g("shortName")
        if g("jScansPositively"):  # south->north: flip so row 0 is north
            vals = vals[::-1]
            lat0 = g("latitudeOfLastGridPointInDegrees")
        lats = lat0 - dj * np.arange(nj)
        lons = lon0 + di * np.arange(ni)
        return name, vals, lats, lons, di
    finally:
        eccodes.codes_release(h)


def decode_uv(buf: bytes) -> Field:
    fields: Dict[str, tuple] = {}
    for m in split_messages(buf):
        name, vals, lats, lons, di = _decode_one(m)
        fields[name] = (vals, lats, lons, di)
    if "10u" not in fields or "10v" not in fields:
        raise ValueError(f"expected 10u/10v, got {sorted(fields)}")
    u, lats, lons, di = fields["10u"]
    v = fields["10v"][0]
    lons = ((lons + 180.0) % 360.0) - 180.0  # 0..360 -> -180..180
    order = np.argsort(lons, kind="stable")
    u = np.nan_to_num(u[:, order]).astype(np.float32)
    v = np.nan_to_num(v[:, order]).astype(np.float32)
    return Field(u, v, lats, lons[order], di)
