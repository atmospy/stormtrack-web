"""NOAA GOES GLM Level-2 LCFA from the public AWS buckets (anonymous HTTPS, no credentials).

File layout: ``GLM-L2-LCFA/<year>/<doy>/<hour>/OR_GLM-L2-LCFA_G19_s<start>_e<end>_c<created>.nc``,
one file per 20 s, ~450 kB. Variables used (verified on a real G19 file):

* ``flash_lat`` / ``flash_lon``  float32 degrees (flash centroid)
* ``flash_time_offset_of_first_event``  uint16 packed, scale_factor 0.0003814756, add_offset -5.0,
  units "seconds since <file start time>"; the epoch is parsed from that units attribute
* ``flash_energy``  uint16 packed, scale_factor 1e-15, add_offset ~2.9e-16, units J (we publish fJ);
  fill value 65535
* ``flash_quality_flag``  uint16; 0 = good, 1/3/5 = degraded (events out of time order / event
  count over threshold / duration over threshold); fill 65535
* ``nominal_satellite_subpoint_lon`` float32 (used for the footprint and overlap rule)

Quality handling: only ``flash_quality_flag == 0`` is kept (``keep_degraded=True`` keeps 1/3/5);
fill-valued energies and non-finite coordinates are dropped.

Overlap rule (GOES-East and GOES-West both see the central Americas / Pacific / Atlantic): a flash
is accepted only from the satellite whose sub-satellite longitude is nearest to the flash
longitude (best viewing geometry, smallest parallax), considering only satellites currently in use.
Each location therefore has exactly one source, so no flash is counted twice; flashes within a
parallax (~0.3 deg) of the midpoint may be dropped or doubled once.
"""

from __future__ import annotations

import io
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np

from . import Batch

SATELLITES = ("G16", "G18", "G19")
# Fallback sub-satellite longitudes if a file does not carry one (operational positions).
DEFAULT_SUB_LON = {"G16": -75.2, "G18": -137.0, "G19": -75.2}
FRESH_S = 30 * 60  # a satellite is "in use" if its newest file is at most this old
NAME_RE = re.compile(
    r"_(G\d\d)_s(\d{4})(\d{3})(\d\d)(\d\d)(\d\d)(\d)_e(\d{4})(\d{3})(\d\d)(\d\d)(\d\d)(\d)"
    r"_c(\d{4})(\d{3})(\d\d)(\d\d)(\d\d)(\d)\.nc$"
)
UA = "stormtrack-web-lightning-ingest/0.1 (+https://github.com/atmospy/stormtrack-web)"


def _bucket_url(sat: str) -> str:
    return f"https://noaa-goes{sat[1:]}.s3.amazonaws.com"


def _stamp(y, doy, h, m, s, tenth) -> float:
    base = datetime(int(y), 1, 1, tzinfo=timezone.utc) + timedelta(days=int(doy) - 1)
    return base.timestamp() + int(h) * 3600 + int(m) * 60 + int(s) + int(tenth) / 10


@dataclass(frozen=True)
class FileRef:
    sat: str
    key: str
    start: float
    end: float
    created: float

    @property
    def name(self) -> str:
        return self.key.rsplit("/", 1)[-1]


def parse_name(key: str) -> FileRef | None:
    m = NAME_RE.search(key)
    if not m:
        return None
    g = m.groups()
    return FileRef(g[0], key, _stamp(*g[1:7]), _stamp(*g[7:13]), _stamp(*g[13:19]))


class Http:
    def __init__(self, retries: int = 3, timeout: float = 30):
        self.retries, self.timeout = retries, timeout

    def get(self, url: str) -> bytes:
        err = None
        for i in range(self.retries):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return r.read()
            except Exception as e:  # noqa: BLE001 - retry any transport error
                err = e
                time.sleep(0.5 * (2**i))
        raise err


def _attr(a, key, default=None):
    v = a.get(key, default)
    return v.decode() if isinstance(v, bytes) else v


def parse_file(data: bytes, keep_degraded: bool = False) -> dict:
    """Parse one GLM L2 LCFA file. Returns arrays (unix-second times, fJ energies) and counts."""
    import h5py

    with h5py.File(io.BytesIO(data), "r") as f:

        def packed(name):
            ds = f[name]
            raw = ds[()]
            if str(_attr(ds.attrs, "_Unsigned", "")).lower() == "true":
                raw = raw.view(raw.dtype.str.replace("i", "u"))
            return raw, ds.attrs

        lat = f["flash_lat"][()].astype("f8")
        lon = f["flash_lon"][()].astype("f8")
        n = lat.size
        if n == 0:
            e = np.empty(0)
            return dict(t=e, lon=e, lat=e, energy_fj=e, n=0, n_bad=0, sub_lon=None, platform=None)
        raw_t, ta = packed("flash_time_offset_of_first_event")
        units = _attr(ta, "units", "")
        m = re.search(r"since (\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?)", units)
        if m:
            epoch = datetime.fromisoformat(m.group(1).replace(" ", "T")).replace(
                tzinfo=timezone.utc
            )
            epoch = epoch.timestamp()
        else:  # fallback: product_time is seconds since the J2000 noon epoch
            epoch = 946728000.0 + _f(f["product_time"][()])
        t = (
            epoch
            + raw_t.astype("f8") * _f(ta.get("scale_factor", 1.0))
            + _f(ta.get("add_offset", 0.0))
        )
        raw_e, ea = packed("flash_energy")
        energy = (raw_e.astype("f8") * _f(ea["scale_factor"]) + _f(ea["add_offset"])) * 1e15
        fill_e = raw_e == 0xFFFF
        raw_q, _ = packed("flash_quality_flag")
        good = (raw_q == 0) if not keep_degraded else np.isin(raw_q, (0, 1, 3, 5))
        ok = good & ~fill_e & np.isfinite(lat) & np.isfinite(lon) & (np.abs(lat) <= 90)
        ok &= np.abs(lon) <= 180
        sub = (
            f["nominal_satellite_subpoint_lon"][()]
            if "nominal_satellite_subpoint_lon" in f
            else None
        )
        return dict(
            t=t[ok],
            lon=lon[ok],
            lat=lat[ok],
            energy_fj=energy[ok],
            n=int(n),
            n_bad=int(n - ok.sum()),
            sub_lon=round(_f(sub), 2) if sub is not None and _f(sub) > -999 else None,
            platform=_attr(f.attrs, "platform_ID"),
        )


def _f(x) -> float:
    return float(np.ravel(x)[0])


def circ_diff(a, b):
    return np.abs((np.asarray(a) - b + 180.0) % 360.0 - 180.0)


class GoesGlm:
    id = "goes-glm"
    name = "NOAA GOES GLM (G16/G18/G19)"
    licence = "NOAA open data (public domain)"
    attribution = "Lightning data: NOAA GOES-R GLM (public domain)"
    kind = "satellite"
    time_precision = "exact"
    time_uncertainty_s = 0
    unofficial = False
    high_volume = True
    decimals = 2
    stale_s = 600
    default_latency_s = 60
    covers_south_asia = False
    coverage_note = "Americas, Atlantic and eastern Pacific"
    coverage_basis = (
        "Union of 52 deg great-circle caps around each GOES satellite's sub-satellite point"
    )

    def __init__(
        self,
        satellites=SATELLITES,
        http: Http | None = None,
        keep_degraded: bool = False,
        workers: int = 8,
        max_files: int = 800,
        fresh_s: float = FRESH_S,
    ):
        self.satellites = tuple(satellites)
        self.http = http or Http()
        self.keep_degraded = keep_degraded
        self.workers = workers
        self.max_files = max_files
        self.fresh_s = fresh_s

    # -- listing ---------------------------------------------------------
    def list_hour(self, sat: str, hour_start: float) -> list:
        dt = datetime.fromtimestamp(hour_start, timezone.utc)
        prefix = f"GLM-L2-LCFA/{dt:%Y}/{dt.timetuple().tm_yday:03d}/{dt:%H}/"
        out, token = [], None
        while True:
            q = {"list-type": "2", "prefix": prefix}
            if token:
                q["continuation-token"] = token
            root = ET.fromstring(self.http.get(f"{_bucket_url(sat)}/?{urllib.parse.urlencode(q)}"))
            ns = root.tag.split("}")[0] + "}" if root.tag.startswith("{") else ""
            for c in root.findall(f"{ns}Contents"):
                ref = parse_name(c.findtext(f"{ns}Key"))
                if ref:
                    out.append(ref)
            if root.findtext(f"{ns}IsTruncated") == "true":
                token = root.findtext(f"{ns}NextContinuationToken")
            else:
                return sorted(out, key=lambda r: r.start)

    def list_since(self, sat: str, since: float, now: float) -> list:
        h = int(since // 3600) * 3600
        refs = []
        while h <= now:
            refs += self.list_hour(sat, h)
            h += 3600
        return [r for r in refs if r.start >= since - 1e-6]

    # -- polling ---------------------------------------------------------
    def poll(self, prev_state, now, window_s, prev_rows=None) -> Batch:
        prev_state = prev_state or {}
        last = prev_state.get("last_file_start", {})
        sub_lon = dict(prev_state.get("sub_lon", {}))
        cutoff = now - window_s
        errors, listed, newest, unused = [], {}, {}, {}
        for sat in self.satellites:
            since = max(cutoff, last.get(sat, 0) + 1e-3) if sat in last else cutoff
            try:
                refs = self.list_since(sat, since, now)
                if sat in last:  # re-listing from a known point: remember it as the newest seen
                    refs = [r for r in refs if r.start > last[sat] + 1e-6]
                # freshness needs the newest file even if there is nothing new
                if refs:
                    newest[sat] = refs[-1].end
                elif sat in last:
                    newest[sat] = last[sat] + 20.0
                listed[sat] = refs
            except Exception as e:  # noqa: BLE001
                errors.append(f"{sat}: listing failed: {e}")
        for sat in self.satellites:
            if sat in listed and not listed[sat] and sat not in newest:
                unused[sat] = f"no files in the last {int(window_s / 60)} min"
            elif sat in newest and now - newest[sat] > self.fresh_s:
                unused[sat] = f"stale: newest file {int((now - newest[sat]) / 60)} min old"
        in_use = [s for s in self.satellites if s in newest and s not in unused]
        refs = [r for s in in_use for r in listed[s]]
        refs.sort(key=lambda r: r.start)
        if len(refs) > self.max_files:
            errors.append(f"truncated {len(refs)} new files to the newest {self.max_files}")
            refs = refs[-self.max_files :]

        def fetch(r):
            try:
                return r, self.http.get(f"{_bucket_url(r.sat)}/{r.key}")
            except Exception as e:  # noqa: BLE001
                return r, e

        parts, nbytes, nfiles, raw_n, bad_n, failed = [], 0, 0, 0, 0, set()
        with ThreadPoolExecutor(self.workers) as ex:
            for r, data in ex.map(fetch, refs):
                if isinstance(data, Exception):
                    errors.append(f"{r.name}: {data}")
                    failed.add(r.sat)
                    continue
                try:
                    p = parse_file(data, self.keep_degraded)
                except Exception as e:  # noqa: BLE001
                    errors.append(f"{r.name}: parse failed: {e}")
                    failed.add(r.sat)
                    continue
                nbytes += len(data)
                nfiles += 1
                raw_n += p["n"]
                bad_n += p["n_bad"]
                if p["sub_lon"] is not None:
                    sub_lon[r.sat] = p["sub_lon"]
                p["sat"] = r.sat
                p["start"] = r.start
                parts.append(p)
        # Advance the per-satellite cursor only over a contiguous prefix of successes so a failed
        # download is retried on the next run.
        new_last = dict(last)
        done = {(p["sat"], p["start"]) for p in parts}
        for sat in in_use:
            for r in listed[sat]:
                if r not in refs:
                    continue
                if (sat, r.start) in done:
                    new_last[sat] = max(new_last.get(sat, 0), r.start)
                else:
                    break
        for sat in in_use:
            sub_lon.setdefault(sat, DEFAULT_SUB_LON[sat])
        use_lon = {s: sub_lon[s] for s in in_use}

        def cat(k):
            return np.concatenate([p[k] for p in parts]) if parts else np.empty(0)

        sats = np.concatenate([[p["sat"]] * len(p["t"]) for p in parts]) if parts else np.empty(0)
        t, lon, lat, en = cat("t"), cat("lon"), cat("lat"), cat("energy_fj")
        if len(use_lon) > 1 and len(t):
            order = list(use_lon)
            d = np.stack([circ_diff(lon, use_lon[s]) for s in order])
            owner = np.array(order)[np.argmin(d, axis=0)]
            keep = owner == sats
            t, lon, lat, en = t[keep], lon[keep], lat[keep], en[keep]
        lat_s = [r.created - r.start for r in refs]
        latency = float(np.median(lat_s)) if lat_s else prev_state.get("latency_s")
        state = {
            "last_file_start": new_last,
            "sub_lon": {
                s: sub_lon[s] for s in sub_lon if s in in_use or s in prev_state.get("sub_lon", {})
            },
            "latency_s": latency,
            "in_use": in_use,
        }
        return Batch(
            t=t,
            lon=lon,
            lat=lat,
            energy_fj=en,
            state=state,
            newest_end=max(newest[s] for s in in_use) if in_use else None,
            satellites=in_use,
            unused=unused,
            files=nfiles,
            bytes=nbytes,
            raw_flashes=raw_n,
            dropped_quality=bad_n,
            latency_s=latency,
            errors=errors,
            failed=any("listing failed" in e for e in errors),
        )

    def coverage(self, state: dict) -> dict:
        from ..footprint import coverage_geojson

        use = state.get("in_use") or list(state.get("sub_lon", {}))
        return coverage_geojson({s: state["sub_lon"][s] for s in use if s in state["sub_lon"]})
