"""Model back-ends: where a run lives, how to range-fetch just the records we need, how to decode.

Every model exposes the same small interface (`Model`). `fetch` returns, per requested field, the
data on the model's *native* 0.25 degree grid (north-first rows, longitudes -180..180) in display
units: wind in m/s, mslp in hPa, t2m and t (temperature on pressure levels) in degC and precip as the **cumulative** depth in mm since the
start of the forecast (the pipeline differences consecutive frames into per-interval depths).
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import gfs, grib, http
from .fields import FieldSpec

log = logging.getLogger("stormtrack.wind")

Key = Tuple[str, ...]


@dataclass
class Native:
    """Decoded field on the source grid. Vectors have `v`; scalars only `u` (the array)."""

    u: np.ndarray
    v: Optional[np.ndarray]
    lats: np.ndarray
    lons: np.ndarray
    d: float


# ---- shared helpers -------------------------------------------------------------------------


def merge_ranges(items: Sequence[Tuple[Key, int, Optional[int]]]):
    """items: (key, offset, length|None) -> merged [(start, end|None, [(key, off, length)])]."""
    items = sorted(items, key=lambda t: t[1])
    groups: List[list] = []
    for key, off, ln in items:
        if groups and groups[-1][1] is not None and groups[-1][1] + 1 == off:
            groups[-1][1] = None if ln is None else off + ln - 1
            groups[-1][2].append((key, off, ln))
        else:
            groups.append([off, None if ln is None else off + ln - 1, [(key, off, ln)]])
    return groups


def gather(url: str, items: Sequence[Tuple[Key, int, Optional[int]]]) -> Dict[Key, bytes]:
    """Byte-range GET of the records, adjacent ones merged into one request. -> {key: message}."""
    out: Dict[Key, bytes] = {}
    for start, end, members in merge_ranges(items):
        blob = http.get(url, (start, end))
        for key, off, ln in members:
            out[key] = blob[off - start : (off - start + ln) if ln is not None else None]
    return out


def _convert(spec: FieldSpec, m: grib.Msg) -> np.ndarray:
    """GRIB native units -> display units, refusing anything unexpected."""
    u = m.units.strip()
    a = m.values.astype(np.float32)
    if spec.group == "mslp":
        if u == "Pa":
            return a / 100.0
        if u == "hPa":
            return a
    elif spec.group in ("t2m", "t"):
        if u == "K":
            return a - np.float32(273.15)
        if u in ("C", "degC"):
            return a
    elif spec.group == "precip":
        if m.start_step != 0:
            raise ValueError(
                f"{spec.slug}: not accumulated from the run start (step {m.start_step})"
            )
        if u in ("kg m**-2", "mm"):
            return a
        if u == "m":
            return a * np.float32(1000.0)
    raise ValueError(f"{spec.slug}: unexpected GRIB units {m.units!r}")


def _build(spec: FieldSpec, msgs: Dict[str, grib.Msg]) -> Native:
    if spec.kind == "vector":
        mu, mv = msgs["u"], msgs["v"]
        if "m s" not in mu.units or "m s" not in mv.units:
            raise ValueError(f"{spec.slug}: wind units {mu.units!r}/{mv.units!r}")
        if spec.pressure and (mu.level != spec.pressure or mu.type_of_level != "isobaricInhPa"):
            raise ValueError(f"{spec.slug}: record is {mu.type_of_level} {mu.level}")
        return Native(mu.values, mv.values, mu.lats, mu.lons, mu.d)
    m = msgs["x"]
    return Native(_convert(spec, m), None, m.lats, m.lons, m.d)


def _decode(spec: FieldSpec, raw: Dict[str, bytes]) -> Native:
    return _build(spec, {k: grib.decode_message(b) for k, b in raw.items()})


# ---- base class -----------------------------------------------------------------------------


class Model:
    id = ""
    name = ""
    licence = ""
    cycles = (0, 6, 12, 18)
    max_workers = 4  # parallel frames; ECMWF's S3 answers 503 SlowDown when hit harder

    def candidate_runs(self, now: dt.datetime, n: int = 8) -> List[dt.datetime]:
        return gfs.candidate_runs(now, n)

    def valid_fhrs(self, run: dt.datetime, fhrs: List[int]) -> List[int]:
        """Subset of the requested hours this model/run actually publishes."""
        return list(fhrs)

    def run_complete(self, run: dt.datetime, fhrs: List[int], workers: int = 8) -> bool:
        raise NotImplementedError

    def find_latest_run(self, now: dt.datetime, hours: int, step: int) -> dt.datetime:
        for r in self.candidate_runs(now):
            fh = self.valid_fhrs(r, list(range(0, hours + 1, step)))
            ok = bool(fh) and self.run_complete(r, fh)
            log.info("[%s] probe run %s: %s", self.id, gfs.run_id(r), "complete" if ok else "no")
            if ok:
                return r
        raise RuntimeError(f"no complete {self.name} run found in the last 48 h")

    def records(self, run: dt.datetime, fhr: int):
        """-> opaque listing of the frame's records (the .idx / .index)."""
        raise NotImplementedError

    def want(self, spec: FieldSpec) -> Dict[str, Key]:
        """spec -> {role: record key}; roles are u/v for vectors, x for scalars."""
        raise NotImplementedError

    def locate(self, listing, key: Key) -> Optional[Tuple[int, Optional[int]]]:
        """-> (offset, length|None) of the record or None when the frame lacks it."""
        raise NotImplementedError

    def url(self, run: dt.datetime, fhr: int) -> str:
        raise NotImplementedError

    def data_url(self, run: dt.datetime, fhr: int) -> str:
        """The GRIB2 object the byte ranges refer to."""
        return self.url(run, fhr)

    def available_specs(self, run, fhr, specs: Sequence[FieldSpec]) -> List[FieldSpec]:
        """Fields whose records exist (probed on one reference frame); the rest are omitted."""
        listing = self.records(run, fhr)
        keep = []
        for s in specs:
            if all(self.locate(listing, k) is not None for k in self.want(s).values()):
                keep.append(s)
            else:
                log.warning("[%s] %s not provided by this model/run; omitted", self.id, s.slug)
        return keep

    def fetch(self, run: dt.datetime, fhr: int, specs: Sequence[FieldSpec]) -> Dict[str, Native]:
        listing = self.records(run, fhr)
        items, plan = [], {}
        for s in specs:
            plan[s.slug] = {}
            for role, key in self.want(s).items():
                loc = self.locate(listing, key)
                if loc is None:
                    raise KeyError(f"[{self.id}] {key} not in the index of f{fhr:03d}")
                items.append(((s.slug, role), loc[0], loc[1]))
        raw = gather(self.data_url(run, fhr), items)
        grouped: Dict[str, Dict[str, bytes]] = {s.slug: {} for s in specs}
        for (slug, role), b in raw.items():
            grouped[slug][role] = b
        return {s.slug: _decode(s, grouped[s.slug]) for s in specs}


# ---- NOAA GFS -------------------------------------------------------------------------------


def parse_idx_full(text: str) -> List[Tuple[int, str, str, str]]:
    """-> [(offset, 'VAR', 'level', 'forecast label'), ...] in file order."""
    out = []
    for line in text.splitlines():
        p = line.split(":")
        if len(p) >= 6:
            out.append((int(p[1]), p[3], p[4], p[5]))
    return out


class GFS(Model):
    id = "gfs"
    name = "NOAA GFS 0.25°"
    licence = "US Government work, public domain"

    def url(self, run, fhr):
        return gfs.base_url(run, fhr)

    def valid_fhrs(self, run, fhrs):
        # f000-f120 hourly, then 3-hourly to f384
        return [f for f in fhrs if f <= 384 and (f <= 120 or f % 3 == 0)]

    def run_complete(self, run, fhrs, workers=8):
        return gfs.run_complete(run, fhrs, workers)

    def records(self, run, fhr):
        base = gfs.base_url(run, fhr)
        return parse_idx_full(http.get(base + ".idx").decode())

    def want(self, spec):
        if spec.group == "wind":
            lvl = "10 m above ground" if spec.pressure is None else f"{spec.pressure} mb"
            return {"u": ("UGRD", lvl), "v": ("VGRD", lvl)}
        if spec.group == "mslp":
            return {"x": ("PRMSL", "mean sea level")}
        if spec.group == "t2m":
            return {"x": ("TMP", "2 m above ground")}
        if spec.group == "t":
            return {"x": ("TMP", f"{spec.pressure} mb")}
        if spec.group == "precip":
            return {"x": ("APCP", "surface")}
        raise KeyError(spec.slug)

    def locate(self, listing, key):
        hits = [i for i, (_, var, lvl, _) in enumerate(listing) if (var, lvl) == key]
        if not hits:
            return None
        # GFS writes two APCP records: the bucket since the last 6 h reset and (second) the running
        # total since the run start. Take the last one: that is the cumulative since f000.
        i = hits[-1] if key[0] == "APCP" else hits[0]
        off = listing[i][0]
        nxt = listing[i + 1][0] if i + 1 < len(listing) else None
        return off, (nxt - off if nxt is not None else None)


# ---- ECMWF open data ------------------------------------------------------------------------

# The same files are served by ECMWF itself and by two public mirrors. In practice the AWS mirror answers 503
# to most requests (12 sequential 1 MB range reads: 9 failed), while ECMWF's own server and Google's mirror
# served all 12. The first base that passes a small range read is used; ECMWF_BASE forces one.
ECMWF_BASES = (
    "https://data.ecmwf.int/forecasts",
    "https://storage.googleapis.com/ecmwf-open-data",
    "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
)
_BASE_CHOSEN: dict = {}


def ecmwf_base(run, sub: str) -> str:
    """The mirror to read from, decided once per process (and per run) by a small range read of the first file."""
    forced = os.environ.get("ECMWF_BASE")
    if forced:
        return forced.rstrip("/")
    key = (run, sub)
    if key not in _BASE_CHOSEN:
        probe = f"{run:%Y%m%d}/{run:%H}z/{sub}/{run:%Y%m%d%H}0000-0h-oper-fc.grib2"
        for base in ECMWF_BASES:
            try:
                http.get(f"{base}/{probe}", byte_range=(0, 255), timeout=20, tries=3)
                _BASE_CHOSEN[key] = base
                log.info("ECMWF mirror: %s", base)
                break
            except http.NotFound:
                # not published yet (a run still being uploaded): says nothing about the mirrors, so decide later
                return ECMWF_BASES[0]
            except Exception as e:  # noqa: BLE001 - any failure means try the next mirror
                log.warning("ECMWF mirror %s not usable (%s)", base, str(e)[:80])
        else:
            _BASE_CHOSEN[key] = ECMWF_BASES[
                0
            ]  # nothing answered: let the normal retries report the real error
    return _BASE_CHOSEN[key]


ECMWF_ATTRIBUTION = (
    "ECMWF open data, licensed CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/). "
    "Copyright © European Centre for Medium-Range Weather Forecasts (ECMWF). "
    "Modified: resampled to a coarser grid and re-encoded as PNG images."
)


class ECMWF(Model):
    max_workers = 1
    sub = ""  # path below <run>/, e.g. "ifs/0p25/oper"

    def url(self, run, fhr):
        return f"{ecmwf_base(run, self.sub)}/{run:%Y%m%d}/{run:%H}z/{self.sub}/{run:%Y%m%d%H}0000-{fhr}h-oper-fc"

    def data_url(self, run, fhr):
        return self.url(run, fhr) + ".grib2"

    def run_complete(self, run, fhrs, workers=8):
        # S3 shows an object only once fully uploaded: every grib2 must exist, and the last
        # step's .index (needed for byte offsets) too.
        if not http.head(self.url(run, fhrs[-1]) + ".grib2"):
            return False
        if not http.head(self.url(run, fhrs[-1]) + ".index"):
            return False
        with ThreadPoolExecutor(workers) as ex:
            return all(ex.map(lambda f: http.head(self.url(run, f) + ".grib2"), fhrs))

    def records(self, run, fhr):
        txt = http.get(self.url(run, fhr) + ".index").decode()
        return [json.loads(line) for line in txt.splitlines() if line.strip()]

    def want(self, spec):
        if spec.group == "wind":
            if spec.pressure is None:
                return {"u": ("10u", "sfc", ""), "v": ("10v", "sfc", "")}
            p = str(spec.pressure)
            return {"u": ("u", "pl", p), "v": ("v", "pl", p)}
        if spec.group == "t":
            return {"x": ("t", "pl", str(spec.pressure))}
        return {
            "x": {
                "mslp": ("msl", "sfc", ""),
                "t2m": ("2t", "sfc", ""),
                "precip": ("tp", "sfc", ""),
            }[spec.group]
        }

    def locate(self, listing, key):
        for r in listing:
            if (r["param"], r.get("levtype"), r.get("levelist", "")) == key:
                return int(r["_offset"]), int(r["_length"])
        return None


class IFS(ECMWF):
    id = "ecmwf-ifs"
    name = "ECMWF IFS HRES 0.25°"
    licence = ECMWF_ATTRIBUTION + " Model: IFS HRES (oper), 0.25 degree open data."
    sub = "ifs/0p25/oper"

    def valid_fhrs(self, run, fhrs):
        # 00/12Z: 3-hourly to 144 h then 6-hourly to 360 h; 06/18Z: 3-hourly to 144 h only
        top = 360 if run.hour in (0, 12) else 144
        return [f for f in fhrs if f <= top and (f <= 144 and f % 3 == 0 or f % 6 == 0)]


class AIFS(ECMWF):
    id = "ecmwf-aifs"
    name = "ECMWF AIFS Single 0.25°"
    licence = ECMWF_ATTRIBUTION + " Model: AIFS Single (ECMWF's AI forecast model), 0.25 degree."
    sub = "aifs-single/0p25/oper"

    def valid_fhrs(self, run, fhrs):
        # AIFS Single is published 6-hourly to 360 h for all four cycles
        return [f for f in fhrs if f <= 360 and f % 6 == 0]


MODELS: Dict[str, Model] = {m.id: m for m in (GFS(), IFS(), AIFS())}


def get_models(arg: str) -> List[Model]:
    out = []
    for tok in [t.strip() for t in arg.split(",") if t.strip()]:
        if tok not in MODELS:
            raise ValueError(f"unknown model {tok!r}; use {','.join(MODELS)}")
        out.append(MODELS[tok])
    if not out:
        raise ValueError("no models selected")
    return out
