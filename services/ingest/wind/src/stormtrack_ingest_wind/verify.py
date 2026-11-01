"""Correctness checks: PNG round trip vs source field, and physical sanity."""

from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

from . import encode

QSTEP = (encode.UV_MAX - encode.UV_MIN) / 255  # 0.392 m/s


def roundtrip_error(png: bytes, u: np.ndarray, v: np.ndarray) -> dict:
    du, dv, ds = encode.decode_png(png)
    uc, vc = np.clip(u, -50, 50), np.clip(v, -50, 50)
    sp = np.minimum(np.hypot(u, v), encode.SPEED_MAX)
    return {
        "u": float(np.abs(du - uc).max()),
        "v": float(np.abs(dv - vc).max()),
        "speed": float(np.abs(ds - sp).max()),
        "step": QSTEP,
        "limit": QSTEP / 2 + 1e-4,
        "ok": bool(
            max(np.abs(du - uc).max(), np.abs(dv - vc).max()) <= QSTEP / 2 + 1e-4
            and np.abs(ds - sp).max() <= encode.SPEED_MAX / 255 / 2 + 1e-4
        ),
    }


def sanity(u: np.ndarray, v: np.ndarray) -> dict:
    """Checks for a north-first global field; row index -> lat via height."""
    h = u.shape[0]
    lat = np.linspace(90, -90, h)
    sp = np.hypot(u, v)
    w = np.cos(np.radians(lat))[:, None] * np.ones_like(sp)
    mean_sp = float((sp * w).sum() / w.sum())  # area-weighted

    def band(c):  # +-2.5 deg
        m = np.abs(lat - c) <= 2.5
        return float(u[m].mean())

    r = {
        "max_speed": float(sp.max()),
        "mean_speed_area_weighted": mean_sp,
        "mean_u_45N": band(45),
        "mean_u_10N": band(10),
    }
    r["ok"] = bool(
        r["max_speed"] < 70 and 3 <= mean_sp <= 9 and r["mean_u_45N"] > 0 and r["mean_u_10N"] < 0
    )
    return r


def point(png: bytes, lat: float, lon: float):
    """Nearest-pixel (u, v, speed) in m/s at lat/lon for an image on the default contract grid."""
    u, v, s = encode.decode_png(png)
    h, w = u.shape
    res = 359.5 / (w - 1) if False else 360.0 / w
    i = int(round((90 - lat) / (180.0 / (h - 1))))
    j = int(round(((lon + 180) % 360) / res)) % w
    return float(u[i, j]), float(v[i, j]), float(s[i, j])


def main(argv=None) -> int:
    from .cli import default_out

    ap = argparse.ArgumentParser(
        prog="verify-wind",
        description="Re-download source GRIB for published frames and compare to the PNGs.",
    )
    ap.add_argument("--out", default=None)
    ap.add_argument("--fhr", type=int, nargs="*", default=[0, 24, 72])
    ap.add_argument("--method", default="nearest")
    a = ap.parse_args(argv)

    from . import gfs, grib, grid

    out = a.out or default_out()
    latest = json.load(open(os.path.join(out, "wind", "latest.json")))
    run = gfs.parse_run(latest["run"][:13])
    res = 360.0 / latest["image"]["width"]
    bad = 0
    for fhr in a.fhr:
        fr = next((f for f in latest["frames"] if f["fhr"] == fhr), None)
        if not fr:
            continue
        f = grib.decode_uv(gfs.fetch_uv(run, fhr))
        u, v, _ = grid.resample(f, res, a.method)
        png = open(os.path.join(out, fr["png"]), "rb").read()
        rt, sn = roundtrip_error(png, u, v), sanity(u, v)
        print(
            f"f{fhr:03d} roundtrip max|err| u={rt['u']:.3f} v={rt['v']:.3f} speed={rt['speed']:.3f} "
            f"(limit {rt['limit']:.3f}) ok={rt['ok']}"
        )
        print(f"      sanity {json.dumps(sn)}")
        bad += (not rt["ok"]) + (not sn["ok"])
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
