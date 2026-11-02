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


# ---- weather v2: scalar round trip, per-field plausibility, published-tree check -----------------


def roundtrip_scalar(png: bytes, x: np.ndarray, lo: float, hi: float, transform=None) -> dict:
    """Max |decode(png) - clip(x)| vs the quantisation step (limit: one step; real max is half)."""
    back = encode.decode_scalar(png, lo, hi, transform)
    xc = np.clip(np.asarray(x, dtype=np.float64), lo, hi)
    if transform == "sqrt":
        err = float(np.abs(np.sqrt(back) - np.sqrt(xc)).max())
        step = encode.scalar_step(lo, hi, transform)
        err_x = float(np.abs(back - xc).max())
    else:
        err = err_x = float(np.abs(back - xc).max())
        step = encode.scalar_step(lo, hi)
    return {"max_err": err_x, "step": step, "err_encoded": err, "ok": bool(err <= step)}


def _areaw(a: np.ndarray) -> float:
    lat = np.linspace(90, -90, a.shape[0])
    w = np.cos(np.radians(lat))[:, None] * np.ones_like(a)
    return float((a * w).sum() / w.sum())


def _band(a: np.ndarray, lo: float, hi: float) -> float:
    lat = np.linspace(90, -90, a.shape[0])
    m = (np.abs(lat) >= lo) & (np.abs(lat) <= hi)
    return float(a[m].mean())


def plausibility(slug: str, fhr: int, **arrays) -> dict:
    """Physical sanity of a decoded global field. mslp/t2m/precip: x=...; winds: u=..., v=..."""
    if slug.startswith("wind_"):
        u, v = arrays["u"], arrays["v"]
        sp = np.hypot(u, v)
        lat = np.linspace(90, -90, u.shape[0])
        m45 = np.abs(lat - 45) <= 2.5
        r = {
            "max_speed": float(sp.max()),
            "mean_speed": _areaw(sp),
            "mean_u_45N": float(u[m45].mean()),
        }
        if slug == "wind_10m":
            r["ok"] = bool(
                r["max_speed"] < 70 and 3 <= r["mean_speed"] <= 9 and r["mean_u_45N"] > 0
            )
        elif slug == "wind_250":
            r["ok"] = bool(
                r["max_speed"] >= 60 and 8 <= r["mean_speed"] <= 40 and r["mean_u_45N"] > 0
            )
        elif slug == "wind_300":
            r["ok"] = bool(
                r["max_speed"] >= 50 and 8 <= r["mean_speed"] <= 40 and r["mean_u_45N"] > 0
            )
        else:  # 850/700/500: westerlies in mid-latitudes, sane means
            r["ok"] = bool(
                r["max_speed"] < 140 and 3 <= r["mean_speed"] <= 35 and r["mean_u_45N"] > 0
            )
        return r
    x = arrays["x"]
    if slug == "mslp":
        r = {
            "min": float(x.min()),
            "p01": float(np.percentile(x, 0.1)),
            "p999": float(np.percentile(x, 99.9)),
            "max": float(x.max()),
            "mean": _areaw(x),
        }
        r["ok"] = bool(
            r["p01"] >= 940 and r["p999"] <= 1060 and r["max"] <= 1070 and 1005 <= r["mean"] <= 1018
        )
    elif slug == "t2m":
        r = {
            "min": float(x.min()),
            "max": float(x.max()),
            "mean": _areaw(x),
            "mean_poles": _band(x, 75, 90),
            "mean_tropics": _band(x, 0, 15),
        }
        r["ok"] = bool(
            8 <= r["mean"] <= 20
            and r["min"] < -25
            and r["max"] > 35
            and r["mean_poles"] < r["mean_tropics"] - 20
        )
    elif slug == "precip":
        r = {
            "min": float(x.min()),
            "max": float(x.max()),
            "mean": _areaw(x),
            "p90": float(np.percentile(x, 90)),
            "frac_dry": float((x < 0.05).mean()),
        }
        if fhr == 0:
            r["ok"] = bool(x.max() == 0)
        else:
            r["ok"] = bool(
                r["min"] >= 0 and r["max"] <= 100 and 0.005 <= r["mean"] <= 3 and r["p90"] < 5
            )
    else:
        raise KeyError(slug)
    return r


def verify_tree(out: str, model: str, fhrs=None, source: bool = False) -> int:
    """Check a published model: PNG decodes per its descriptor, plausibility per field, and (with
    `source`) a round trip against a fresh download of the source records. Returns #failures."""
    latest = json.load(open(os.path.join(out, "weather", model, "latest.json")))
    bad = 0
    if source:
        from . import fields, gfs, grid, models

        mdl = models.MODELS[model]
        run = gfs.parse_run(latest["run"][:13])
    for fld in latest["fields"]:
        slug = fld["slug"]
        for fr in fld["frames"]:
            if fhrs is not None and fr["fhr"] not in fhrs:
                continue
            png = open(os.path.join(out, fr["png"]), "rb").read()
            if fld["kind"] == "vector":
                rg = fld["range"]
                rng = encode.VectorRange(rg["u"][0], rg["u"][1], rg["speed_max"])
                u, v, _ = encode.decode_vector(png, rng)
                pl = plausibility(slug, fr["fhr"], u=u, v=v)
                msg = f"mean {pl['mean_speed']:.1f} max {pl['max_speed']:.1f} m/s"
            else:
                lo, hi = fld["range"]
                x = encode.decode_scalar(png, lo, hi, fld.get("transform"))
                pl = plausibility(slug, fr["fhr"], x=x)
                msg = " ".join(f"{k}={v:.3g}" for k, v in pl.items() if k != "ok")
            line = f"{model} {slug:9s} f{fr['fhr']:03d} plausible={pl['ok']}  {msg}"
            bad += not pl["ok"]
            if source:
                # re-download this frame's source records and compare to the PNG
                spec = fields.BY_SLUG[slug]
                res = round(360.0 / latest["grid"]["width"], 6)
                fh = fr["fhr"]
                if spec.group == "precip":
                    if fh == 0:
                        continue
                    ph = [f["fhr"] for f in fld["frames"]]
                    prev = ph[ph.index(fh) - 1]

                    def cum(h):
                        if h == 0:
                            return None
                        n = mdl.fetch(run, h, [spec])[slug]
                        return grid.resample_array(n.u, n.d, n.lons, n.lats, res)[0]

                    a, b = cum(fh), cum(prev)
                    ref = np.maximum(a - (b if b is not None else 0), 0)
                    rt = roundtrip_scalar(png, ref, lo, hi, fld.get("transform"))
                elif spec.kind == "vector":
                    n = mdl.fetch(run, fh, [spec])[slug]
                    from .grib import Field

                    ru, rv, _ = grid.resample(Field(n.u, n.v, n.lats, n.lons, n.d), res)
                    rt = roundtrip_error_vec(png, ru, rv, rng)
                else:
                    n = mdl.fetch(run, fh, [spec])[slug]
                    ref = grid.resample_array(n.u, n.d, n.lons, n.lats, res)[0]
                    rt = roundtrip_scalar(png, ref, lo, hi, fld.get("transform"))
                line += f"  | source round-trip max|err|={rt.get('max_err', rt.get('u')):.4g} ok={rt['ok']}"
                bad += not rt["ok"]
            print(line)
    return bad


def roundtrip_error_vec(png: bytes, u, v, rng: encode.VectorRange) -> dict:
    du, dv, ds = encode.decode_vector(png, rng)
    eu = float(np.abs(du - np.clip(u, rng.lo, rng.hi)).max())
    ev = float(np.abs(dv - np.clip(v, rng.lo, rng.hi)).max())
    sp = np.minimum(np.hypot(u, v), rng.speed_max)
    es = float(np.abs(ds - sp).max())
    ok = max(eu, ev) <= rng.step / 2 + 1e-4 and es <= rng.speed_max / 255 / 2 + 1e-4
    return {"u": eu, "v": ev, "speed": es, "ok": bool(ok)}


def main_weather(argv=None) -> int:
    from .cli import default_out

    ap = argparse.ArgumentParser(
        prog="verify-weather",
        description="Check published weather/<model> frames: decode, plausibility per field "
        "and (--source) round trip against a fresh download of the source GRIB records.",
    )
    ap.add_argument("--out", default=None)
    ap.add_argument("--models", default="gfs,ecmwf-ifs,ecmwf-aifs")
    ap.add_argument("--fhr", type=int, nargs="*", default=[0, 24, 72])
    ap.add_argument("--source", action="store_true", help="also compare to the source (network)")
    a = ap.parse_args(argv)
    out = a.out or default_out()
    bad = 0
    for m in a.models.split(","):
        if os.path.exists(os.path.join(out, "weather", m, "latest.json")):
            bad += verify_tree(out, m, set(a.fhr), a.source)
        else:
            print(f"{m}: not published, skipped")
    print("FAILED checks:", bad)
    return 1 if bad else 0


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
