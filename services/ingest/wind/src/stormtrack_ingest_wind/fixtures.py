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
    for k, v in [
        ("Ni", nlon),
        ("Nj", nlat),
        ("latitudeOfFirstGridPointInDegrees", 90.0),
        ("longitudeOfFirstGridPointInDegrees", 0.0),
        ("latitudeOfLastGridPointInDegrees", -90.0),
        ("longitudeOfLastGridPointInDegrees", 360.0 - d),
        ("iDirectionIncrementInDegrees", d),
        ("jDirectionIncrementInDegrees", d),
        ("jScansPositively", 0),
        ("bitsPerValue", 16),
        ("packingType", "grid_complex_spatial_differencing"),
        ("discipline", 0),
        ("parameterCategory", 2),
        ("parameterNumber", 2 if name == "10u" else 3),
        ("typeOfFirstFixedSurface", 103),
        ("scaleFactorOfFirstFixedSurface", 0),
        ("scaledValueOfFirstFixedSurface", 10),
    ]:
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
    lines = [
        "1:0:d=2026110106:TMP:2 m above ground:anl:",
        f"2:{n_before}:d=2026110106:UGRD:10 m above ground:anl:",
        f"3:{n_before + len(u)}:d=2026110106:VGRD:10 m above ground:anl:",
        f"4:{n_before + len(u) + len(v)}:d=2026110106:ICEG:10 m above mean sea level:anl:",
    ]
    return body, "\n".join(lines) + "\n"


# ---- a fake "world": GFS + ECMWF IFS/AIFS buckets with realistic multi-record files -------------

import json  # noqa: E402
import re  # noqa: E402

from . import http  # noqa: E402


def _grib(
    short: str, vals: np.ndarray, d: float, lon0: float = 0.0, tol=None, level=None, centre=None
) -> bytes:
    """One GRIB2 message with the given shortName (units follow from it), north-first."""
    import eccodes

    h = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    nlat, nlon = vals.shape
    if lon0 == 180.0:  # ECMWF open data starts at 180E: columns are lon 180..360, 0..180
        vals = np.roll(vals, -nlon // 2, axis=1)
    keys = [
        ("Ni", nlon),
        ("Nj", nlat),
        ("latitudeOfFirstGridPointInDegrees", 90.0),
        ("longitudeOfFirstGridPointInDegrees", lon0),
        ("latitudeOfLastGridPointInDegrees", -90.0),
        ("longitudeOfLastGridPointInDegrees", (lon0 + 360.0 - d) % 360.0),
        ("iDirectionIncrementInDegrees", d),
        ("jDirectionIncrementInDegrees", d),
        ("jScansPositively", 0),
        ("bitsPerValue", 16),
        ("shortName", short),
    ]
    if tol == "isobaricInhPa":
        keys += [("typeOfFirstFixedSurface", 100), ("scaledValueOfFirstFixedSurface", level * 100)]
    for k, v in keys:
        eccodes.codes_set(h, k, v)
    eccodes.codes_set_values(h, vals.ravel())
    out = bytes(eccodes.codes_get_message(h))
    eccodes.codes_release(h)
    return out


def world_fields(d: float, fhr: int):
    """Smooth, physically plausible global fields on a north-first 0..360 grid (SI units)."""
    nlat, nlon = int(180 / d) + 1, int(360 / d)
    la = np.radians(90 - d * np.arange(nlat))[:, None] * np.ones((1, nlon))
    lo = np.radians(d * np.arange(nlon))[None, :] * np.ones((nlat, 1))
    f = {
        "msl": 101300 + 1500 * np.cos(4 * la) + 900 * np.sin(lo) * np.cos(la) - 20 * fhr,
        "2t": 255 + 50 * np.cos(la) ** 2 + 4 * np.sin(lo) + 0.05 * fhr,
        # cumulative precipitation in mm since the run start: grows with the forecast hour
        "tp_mm": (fhr / 3.0) * (0.4 + 0.4 * np.cos(2 * lo)) * np.cos(la) ** 2 * 2.0,
        "10u": np.where(np.abs(la) < 0.5, -6.0, 9.0) + 3 * np.cos(lo),
        "10v": 4 * np.sin(2 * lo) * np.cos(la),
    }
    for p in (850, 700, 500, 300, 250):
        k = {850: 1.0, 700: 1.5, 500: 2.0, 300: 3.0, 250: 3.4}[p]
        f[f"u{p}"] = k * (np.where(np.abs(la) < 0.5, -4.0, 14.0) + 3 * np.cos(lo)) + 12 * k * (
            np.exp(-(((np.degrees(la) - 40) / 8) ** 2))
        )
        f[f"v{p}"] = k * 5 * np.sin(2 * lo) * np.cos(la)
    return {k: v.astype(np.float64) for k, v in f.items()}


class FakeWorld:
    """Mock of the NOAA GFS bucket and the ECMWF open-data bucket; patch `http.get/head` with it."""

    def __init__(self, d: float = 2.0, avail=None):
        self.d = d
        self.avail = set(avail or [])  # {("gfs", "2026110112"), ("ecmwf-ifs", ...), ...}
        self.gets = []
        self._cache = {}

    # -- file builders ------------------------------------------------------------------
    def _gfs(self, fhr):
        f = world_fields(self.d, fhr)
        pa = lambda k: f[k]  # noqa: E731
        recs = [("PRMSL", "mean sea level", _grib("prmsl", pa("msl"), self.d))]
        recs.append(("TMP", "2 mb", b"D" * 777))  # decoy: must never be picked for 2 m T
        for p in (250, 300, 500, 700, 850):
            recs.append(("UGRD", f"{p} mb", _grib("u", f[f"u{p}"], self.d, 0, "isobaricInhPa", p)))
            recs.append(("VGRD", f"{p} mb", _grib("v", f[f"v{p}"], self.d, 0, "isobaricInhPa", p)))
        recs.append(("TMP", "2 m above ground", _grib("2t", pa("2t"), self.d)))
        recs.append(("UGRD", "10 m above ground", _grib("10u", pa("10u"), self.d)))
        recs.append(("VGRD", "10 m above ground", _grib("10v", pa("10v"), self.d)))
        if fhr > 0:
            # GFS writes the 6 h bucket first, then the running total; the bucket is a decoy here
            tp = f["tp_mm"] / 1000.0
            recs.append(("APCP", "surface", _grib("tp", tp * 0.37, self.d)))
            recs.append(("APCP", "surface", _grib("tp", tp, self.d)))
        body, lines, off = b"", [], 0
        for n, (var, lvl, msg) in enumerate(recs, 1):
            lines.append(f"{n}:{off}:d=2026110112:{var}:{lvl}:{fhr} hour fcst:")
            body += msg
            off += len(msg)
        return body, "\n".join(lines) + "\n"

    def _ecmwf(self, mid, fhr):
        f = world_fields(self.d, fhr)
        recs = [("msl", "sfc", "", _grib("msl", f["msl"], self.d, 180.0))]
        recs.append(("z", "pl", "500", b"Z" * 555))  # decoy
        recs.append(("2t", "sfc", "", _grib("2t", f["2t"], self.d, 180.0)))
        if fhr > 0:
            msg = _grib("tp", f["tp_mm"] / 1000.0, self.d, 180.0)  # metres
            recs.append(("tp", "sfc", "", msg))
        recs.append(("10u", "sfc", "", _grib("10u", f["10u"], self.d, 180.0)))
        recs.append(("10v", "sfc", "", _grib("10v", f["10v"], self.d, 180.0)))
        for p in (850, 700, 500, 300, 250):
            recs.append(
                ("u", "pl", str(p), _grib("u", f[f"u{p}"], self.d, 180.0, "isobaricInhPa", p))
            )
            recs.append(
                ("v", "pl", str(p), _grib("v", f[f"v{p}"], self.d, 180.0, "isobaricInhPa", p))
            )
        body, rows, off = b"", [], 0
        for param, lt, lv, msg in recs:
            row = {
                "param": param,
                "levtype": lt,
                "step": str(fhr),
                "_offset": off,
                "_length": len(msg),
            }
            if lv:
                row["levelist"] = lv
            rows.append(json.dumps(row))
            body += msg
            off += len(msg)
        return body, "\n".join(rows) + "\n"

    # -- URL routing --------------------------------------------------------------------
    def _route(self, url):
        m = re.search(r"gfs\.(\d{8})/(\d\d)/atmos/gfs\.t\d\dz\.pgrb2\.0p25\.f(\d{3})(\.idx)?$", url)
        if m:
            return "gfs", m.group(1) + m.group(2), int(m.group(3)), m.group(4) and "idx" or "data"
        m = re.search(
            r"/(\d{8})/(\d\d)z/(ifs|aifs-single)/0p25/oper/\d{10}0000-(\d+)h-oper-fc\.(\w+)$", url
        )
        if m:
            mid = "ecmwf-ifs" if m.group(3) == "ifs" else "ecmwf-aifs"
            return (
                mid,
                m.group(1) + m.group(2),
                int(m.group(4)),
                "index" if m.group(5) == "index" else "data",
            )
        return None

    def _exists(self, mid, run, fhr):
        if (mid, run) not in self.avail:
            return False
        if mid == "ecmwf-aifs":
            return fhr % 6 == 0
        if mid == "ecmwf-ifs":
            return fhr % 3 == 0 and fhr <= 144
        return True

    def _file(self, mid, run, fhr):
        key = (mid, run, fhr)
        if key not in self._cache:
            self._cache[key] = self._gfs(fhr) if mid == "gfs" else self._ecmwf(mid, fhr)
        return self._cache[key]

    def head(self, url, timeout=20):
        r = self._route(url)
        return bool(r) and self._exists(r[0], r[1], r[2])

    def get(self, url, byte_range=None, timeout=60):
        r = self._route(url)
        if not r or not self._exists(r[0], r[1], r[2]):
            raise http.NotFound(url)
        body, listing = self._file(r[0], r[1], r[2])
        if r[3] in ("idx", "index"):
            return listing.encode()
        self.gets.append((url, byte_range))
        a, b = byte_range
        return body[a : (b + 1) if b is not None else None]

    def install(self, monkeypatch):
        monkeypatch.setattr(http, "head", self.head)
        monkeypatch.setattr(http, "get", self.get)
        return self
