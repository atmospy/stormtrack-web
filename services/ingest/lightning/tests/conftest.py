"""Synthetic GLM-style NetCDF fixtures (written with h5py, the same library used to read them)."""

from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

import h5py
import numpy as np
import pytest

T_SCALE, T_OFF = 0.0003814756, -5.0
E_SCALE, E_OFF = 9.99996e-16, 2.8515e-16


def utc(*a) -> float:
    return datetime(*a, tzinfo=timezone.utc).timestamp()


def fname(sat: str, start: float, created_lag: float = 40.0) -> str:
    def f(ts):
        d = datetime.fromtimestamp(ts, timezone.utc)
        doy = d.timetuple().tm_yday
        return f"{d:%Y}{doy:03d}{d:%H%M%S}{int((ts % 1) * 10)}"

    return f"OR_GLM-L2-LCFA_{sat}_s{f(start)}_e{f(start + 20)}_c{f(start + created_lag)}.nc"


def key_for(sat: str, start: float) -> str:
    d = datetime.fromtimestamp(start, timezone.utc)
    return f"GLM-L2-LCFA/{d:%Y}/{d.timetuple().tm_yday:03d}/{d:%H}/{fname(sat, start)}"


def make_glm(
    start: float,
    flashes: list,
    sub_lon: float = -75.2,
    sat: str = "G19",
    quality: list | None = None,
) -> bytes:
    """flashes: list of (t_abs, lon, lat, energy_fj)."""
    n = len(flashes)
    buf = io.BytesIO()
    with h5py.File(buf, "w") as f:
        f.attrs["platform_ID"] = sat

        def packed(name, vals, scale=None, off=None, extra=None):
            ds = f.create_dataset(name, data=np.asarray(vals, dtype="<u2").view("<i2"))
            ds.attrs["_Unsigned"] = "true"
            if scale is not None:
                ds.attrs["scale_factor"] = np.float32(scale)
                ds.attrs["add_offset"] = np.float32(off)
            for k, v in (extra or {}).items():
                ds.attrs[k] = v
            return ds

        f.create_dataset("flash_lat", data=np.array([x[2] for x in flashes], "f4"))
        f.create_dataset("flash_lon", data=np.array([x[1] for x in flashes], "f4"))
        epoch = datetime.fromtimestamp(start, timezone.utc).strftime("%Y-%m-%d %H:%M:%S.000")
        offs = [round((x[0] - start - T_OFF) / T_SCALE) for x in flashes]
        packed(
            "flash_time_offset_of_first_event",
            offs,
            T_SCALE,
            T_OFF,
            {"units": f"seconds since {epoch}"},
        )
        en = [
            round((x[3] * 1e-15 - E_OFF) / E_SCALE) if x[3] is not None else 65535 for x in flashes
        ]
        packed("flash_energy", en, E_SCALE, E_OFF, {"units": b"J"})
        packed("flash_quality_flag", quality if quality is not None else [0] * n)
        f.create_dataset("nominal_satellite_subpoint_lon", data=np.float32(sub_lon))
        f.create_dataset("product_time", data=np.float64(start - 946728000))
    return buf.getvalue()


class FakeS3:
    """Serves bucket listings and objects for the GoesGlm source from an in-memory dict."""

    def __init__(self):
        self.objects: dict = {}  # (sat, key) -> bytes
        self.gets: list = []
        self.fail_listing = False

    def add(self, sat: str, start: float, flashes: list, **kw):
        data = make_glm(start, flashes, sat=sat, **kw)
        self.objects[(sat, key_for(sat, start))] = data
        return data

    def get(self, url: str) -> bytes:
        import re
        import urllib.parse

        self.gets.append(url)
        sat = "G" + re.search(r"noaa-goes(\d\d)", url).group(1)
        if "list-type=2" in url:
            if self.fail_listing:
                raise OSError("network down")
            prefix = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["prefix"][0]
            keys = sorted(k for (s, k) in self.objects if s == sat and k.startswith(prefix))
            body = "".join(f"<Contents><Key>{k}</Key></Contents>" for k in keys)
            return (
                '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                f"<IsTruncated>false</IsTruncated>{body}</ListBucketResult>"
            ).encode()
        key = urllib.parse.urlparse(url).path.lstrip("/")
        return self.objects[(sat, key)]


@pytest.fixture
def s3():
    return FakeS3()


def populate(s3: FakeS3, now: float, minutes: int = 10, sats=(("G19", -75.2), ("G18", -137.0))):
    """Files every 20 s over the last ``minutes``, 3 flashes each near the satellite's own area."""
    t = (now - minutes * 60) // 20 * 20
    while t + 20 <= now - 30:
        for sat, sub in sats:
            fl = [
                (t + 1, sub + 5, 10.0, 100.0),
                (t + 8, sub - 8, 20.0, 50.0),
                (t + 15, sub + 12, -5.0, 10.0),
            ]
            s3.add(sat, t, fl, sub_lon=sub)
        t += 20


NOW = utc(2026, 11, 1, 19, 30, 0)
__all__ = ["NOW", "FakeS3", "key_for", "make_glm", "populate", "utc", "timedelta"]
