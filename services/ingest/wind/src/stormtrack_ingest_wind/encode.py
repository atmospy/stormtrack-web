"""PNG encoding per docs/CONTRACTS.md section 1."""

from __future__ import annotations

import io
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np
from PIL import Image

UV_MIN, UV_MAX, SPEED_MAX = -50.0, 50.0, 70.0


@dataclass(frozen=True)
class VectorRange:
    """Per-field encoding range of a vector field (CONTRACTS 1b: `range`)."""

    lo: float
    hi: float
    speed_max: float

    @property
    def step(self) -> float:
        return (self.hi - self.lo) / 255


WIND_10M = VectorRange(UV_MIN, UV_MAX, SPEED_MAX)  # the v1 contract range


def vector_rgba(u: np.ndarray, v: np.ndarray, rng: VectorRange = WIND_10M) -> np.ndarray:
    speed = np.hypot(u, v)
    span = rng.hi - rng.lo
    r = np.rint((np.clip(u, rng.lo, rng.hi) - rng.lo) / span * 255)
    g = np.rint((np.clip(v, rng.lo, rng.hi) - rng.lo) / span * 255)
    b = np.rint(np.minimum(speed, rng.speed_max) / rng.speed_max * 255)
    a = np.full(u.shape, 255)
    return np.stack([r, g, b, a], -1).astype(np.uint8)


def _png(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    # Pillow writes no gAMA/iCCP/sRGB chunks unless asked; 8-bit RGBA, lossless.
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", optimize=True, compress_level=9)
    return buf.getvalue()


def vector_png(u: np.ndarray, v: np.ndarray, rng: VectorRange = WIND_10M) -> bytes:
    return _png(vector_rgba(u, v, rng))


def decode_vector(data: bytes, rng: VectorRange = WIND_10M):
    """-> (u, v, speed) float32 in m/s (inverse of the contract formulas)."""
    im = _load_rgba(data)
    r, g, b = (im[..., i].astype(np.float32) for i in range(3))
    span = rng.hi - rng.lo
    return r / 255 * span + rng.lo, g / 255 * span + rng.lo, b / 255 * rng.speed_max


def _load_rgba(data: bytes) -> np.ndarray:
    im = np.asarray(Image.open(io.BytesIO(data)))
    assert im.ndim == 3 and im.shape[2] == 4 and im.dtype == np.uint8, "need 8-bit RGBA"
    return im


# ---- scalar fields: 16-bit packed into R (high byte) and G (low byte) ---------------------------


def _tf(x, transform: Optional[str]):
    if transform is None:
        return x
    if transform == "sqrt":
        return np.sqrt(np.maximum(x, 0.0))
    raise ValueError(f"unknown transform {transform!r}")


def scalar_step(lo: float, hi: float, transform: Optional[str] = None) -> float:
    """Quantisation step in the *encoded* domain (x itself when there is no transform)."""
    return float(_tf(hi, transform) - _tf(lo, transform)) / 65535


def scalar_pack(x: np.ndarray, lo: float, hi: float, transform: Optional[str] = None) -> np.ndarray:
    """-> uint16 v16 = round((t(x) - t(lo)) / (t(hi) - t(lo)) * 65535), clipped to the range."""
    tlo, thi = float(_tf(lo, transform)), float(_tf(hi, transform))
    t = _tf(np.nan_to_num(np.asarray(x, dtype=np.float64), nan=lo), transform)
    return np.rint(np.clip((t - tlo) / (thi - tlo), 0.0, 1.0) * 65535).astype(np.uint16)


def scalar_png(x: np.ndarray, lo: float, hi: float, transform: Optional[str] = None) -> bytes:
    v16 = scalar_pack(x, lo, hi, transform)
    rgba = np.empty(x.shape + (4,), np.uint8)
    rgba[..., 0] = v16 >> 8
    rgba[..., 1] = v16 & 255
    rgba[..., 2] = 0
    rgba[..., 3] = 255
    return _png(rgba)


def decode_scalar(data: bytes, lo: float, hi: float, transform: Optional[str] = None) -> np.ndarray:
    """-> float64 values in display units (inverse of `scalar_png`)."""
    im = _load_rgba(data)
    v16 = (im[..., 0].astype(np.uint32) << 8) | im[..., 1].astype(np.uint32)
    tlo, thi = float(_tf(lo, transform)), float(_tf(hi, transform))
    t = tlo + v16.astype(np.float64) / 65535 * (thi - tlo)
    return t * t if transform == "sqrt" else t


def to_rgba(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    return vector_rgba(u, v, WIND_10M)


def png_bytes(u: np.ndarray, v: np.ndarray) -> bytes:
    return vector_png(u, v, WIND_10M)


def decode_png(data: bytes):
    """-> (u, v, speed) float32 in m/s for the v1 10 m wind range."""
    return decode_vector(data, WIND_10M)


def atomic_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
