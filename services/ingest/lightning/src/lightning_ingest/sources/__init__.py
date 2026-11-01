"""Lightning sources.

EXTENSION POINT: to add a second source (e.g. EUMETSAT MTG Lightning Imager, which needs a free
Data Store key and covers Europe / Africa / Middle East / Atlantic), add a module here that
implements the ``Source`` protocol below, register it in ``default_sources`` and give it a distinct
``id``. The pipeline merges, prunes, thins and publishes whatever the sources return; it does
not know about GOES. A source must (a) only fetch what is new since ``prev_state`` (its own opaque
dict, stored under ``index.state[<id>]``), (b) return flashes with unix-second times, and (c) return
a footprint (``sub_lons``-style data is source specific; the pipeline asks the source for
``coverage_features``). Overlap with other sources must be resolved by a spatial rule inside
the source or by extending ``pipeline.merge``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np


@dataclass
class Batch:
    """New flashes from one source plus bookkeeping."""

    t: np.ndarray  # unix seconds, float64
    lon: np.ndarray
    lat: np.ndarray
    energy_fj: np.ndarray
    state: dict  # opaque per-source state to persist in index.state[<id>]
    newest_end: float | None = None  # unix seconds of the end of the newest file seen (any age)
    satellites: list = field(default_factory=list)  # satellites in use
    unused: dict = field(default_factory=dict)  # satellite -> reason it is not used
    files: int = 0
    bytes: int = 0
    raw_flashes: int = 0  # flashes read from files before quality filtering
    dropped_quality: int = 0
    latency_s: float | None = None
    errors: list = field(default_factory=list)
    failed: bool = False  # the source could not be reached / parsed in this run


class Source(Protocol):
    """Static attributes (all published in ``index.sources[i]``; CONTRACTS 6.1)."""

    id: str
    name: str
    licence: str
    attribution: str
    kind: str  # "satellite" | "ground-network"
    time_precision: str  # "exact" | "bucketed"
    time_uncertainty_s: float
    unofficial: bool
    high_volume: bool  # only these are thinned to the row cap
    decimals: int  # lon/lat precision of the published rows
    stale_s: float  # no data newer than this => stale
    default_latency_s: float
    covers_south_asia: bool
    coverage_note: str  # short text for index.notes
    coverage_basis: str

    def poll(
        self,
        prev_state: dict | None,
        now: float,
        window_s: float,
        prev_rows: tuple | None = None,  # this source's previously published (t, lon, lat)
    ) -> Batch: ...

    def coverage(self, state: dict) -> dict:
        """GeoJSON FeatureCollection (labelled approximate) for the satellites in ``state``."""
        ...


SOURCE_IDS = ("goes-glm", "iitm-damini")


def default_sources(names=("goes-glm",), glm: dict | None = None, iitm: dict | None = None):
    """Build the requested sources (order = ``src`` index order in flashes.json)."""
    out = []
    for n in names:
        if n == "goes-glm":
            from .goes_glm import GoesGlm

            out.append(GoesGlm(**(glm or {})))
        elif n == "iitm-damini":
            from .iitm_damini import IitmDamini

            out.append(IitmDamini(**(iitm or {})))
        else:
            raise ValueError(f"unknown source {n!r}; choose from {', '.join(SOURCE_IDS)}")
    return out
