"""PNG encoding per docs/CONTRACTS.md section 1."""

from __future__ import annotations

import io
import os

import numpy as np
from PIL import Image

UV_MIN, UV_MAX, SPEED_MAX = -50.0, 50.0, 70.0


def to_rgba(u: np.ndarray, v: np.ndarray) -> np.ndarray:
    speed = np.hypot(u, v)
    r = np.rint((np.clip(u, UV_MIN, UV_MAX) - UV_MIN) / (UV_MAX - UV_MIN) * 255)
    g = np.rint((np.clip(v, UV_MIN, UV_MAX) - UV_MIN) / (UV_MAX - UV_MIN) * 255)
    b = np.rint(np.minimum(speed, SPEED_MAX) / SPEED_MAX * 255)
    a = np.full(u.shape, 255)
    return np.stack([r, g, b, a], -1).astype(np.uint8)


def png_bytes(u: np.ndarray, v: np.ndarray) -> bytes:
    buf = io.BytesIO()
    # Pillow writes no gAMA/iCCP/sRGB chunks unless asked; 8-bit RGBA, lossless.
    Image.fromarray(to_rgba(u, v), "RGBA").save(buf, "PNG", optimize=True, compress_level=9)
    return buf.getvalue()


def decode_png(data: bytes):
    """-> (u, v, speed) float32 in m/s (inverse of the contract formulas)."""
    im = np.asarray(Image.open(io.BytesIO(data)))
    assert im.ndim == 3 and im.shape[2] == 4 and im.dtype == np.uint8, "need 8-bit RGBA"
    r, g, b = (im[..., i].astype(np.float32) for i in range(3))
    u = r / 255 * (UV_MAX - UV_MIN) + UV_MIN
    v = g / 255 * (UV_MAX - UV_MIN) + UV_MIN
    return u, v, b / 255 * SPEED_MAX


def atomic_write(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)
