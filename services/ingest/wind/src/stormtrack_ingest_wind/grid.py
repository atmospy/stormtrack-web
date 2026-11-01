"""Resample a source Field to the contract grid."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .grib import Field


@dataclass
class Grid:
    width: int
    height: int
    lon_left: float
    lon_right: float
    lat_top: float
    lat_bottom: float


def _box(a: np.ndarray, n: int, axis: int, wrap: bool) -> np.ndarray:
    """Mean over an odd window of size (n if odd else n+1), centred on each sample."""
    w = n if n % 2 else n + 1
    h = w // 2
    pad = [(0, 0)] * a.ndim
    pad[axis] = (h, h)
    p = np.pad(a, pad, mode="wrap" if wrap else "edge")
    acc = np.zeros_like(a, dtype=np.float64)
    for k in range(w):
        sl = [slice(None)] * a.ndim
        sl[axis] = slice(k, k + a.shape[axis])
        acc += p[tuple(sl)]
    return (acc / w).astype(np.float32)


def resample(f: Field, res: float, method: str = "nearest"):
    """-> (u, v, Grid). `res` must be an integer multiple of the source spacing."""
    n = int(round(res / f.d))
    if abs(n * f.d - res) > 1e-6:
        raise ValueError(f"res {res} is not a multiple of source spacing {f.d}")
    nlat, nlon = f.u.shape
    if (nlat - 1) % n or nlon % n:
        raise ValueError("source grid not divisible by step")
    u, v = f.u, f.v
    if method == "mean" and n > 1:
        u = _box(_box(u, n, 1, True), n, 0, False)
        v = _box(_box(v, n, 1, True), n, 0, False)
    elif method not in ("nearest", "mean"):
        raise ValueError("method must be nearest|mean")
    # nearest: every Nth point, starting at the north pole row and lon -180
    u, v = u[::n, ::n], v[::n, ::n]
    h, w = u.shape
    g = Grid(w, h, float(f.lons[0]), float(f.lons[0] + (w - 1) * res),
             float(f.lats[0]), float(f.lats[0] - (h - 1) * res))
    return np.ascontiguousarray(u), np.ascontiguousarray(v), g
