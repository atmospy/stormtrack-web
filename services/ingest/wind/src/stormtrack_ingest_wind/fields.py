"""The field catalogue (CONTRACTS 1b): slugs, units, encoding ranges, level selection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .encode import VectorRange

PRESSURE_LEVELS = (850, 700, 500, 300, 250)

# (u/v range, speed_max) per level. 10 m keeps the v1 range; 250 hPa follows the contract example.
_VRANGE: Dict[str, VectorRange] = {
    "10m": VectorRange(-50, 50, 70),
    "850": VectorRange(-60, 60, 85),
    "700": VectorRange(-70, 70, 100),
    "500": VectorRange(-80, 80, 115),
    "300": VectorRange(-100, 100, 140),
    "250": VectorRange(-100, 100, 140),
}


@dataclass(frozen=True)
class FieldSpec:
    id: str  # "wind@850hPa", "mslp"
    slug: str  # "wind_850", "mslp"
    kind: str  # vector | scalar
    units: str
    group: str  # wind | mslp | t2m | precip  (what --fields selects)
    level: Optional[Tuple[str, int, str]] = None  # (type, value, label)
    vrange: Optional[VectorRange] = None
    srange: Optional[Tuple[float, float]] = None
    transform: Optional[str] = None

    @property
    def pressure(self) -> Optional[int]:
        return self.level[1] if self.level and self.level[0] == "pressure" else None

    def descriptor(self) -> dict:
        """The per-field part of <model>/latest.json, without `frames`."""
        d = {"id": self.id, "slug": self.slug, "kind": self.kind, "units": self.units}
        if self.level:
            d["level"] = {"type": self.level[0], "value": self.level[1], "label": self.level[2]}
        if self.kind == "vector":
            r = self.vrange
            d["range"] = {"u": [r.lo, r.hi], "v": [r.lo, r.hi], "speed_max": r.speed_max}
        else:
            d["range"] = list(self.srange)
            if self.transform:
                d["transform"] = self.transform
        return d


def _wind(level: str) -> FieldSpec:
    if level == "10m":
        return FieldSpec(
            "wind@10m",
            "wind_10m",
            "vector",
            "m/s",
            "wind",
            ("height_agl", 10, "10 m"),
            _VRANGE["10m"],
        )
    p = int(level)
    return FieldSpec(
        f"wind@{p}hPa",
        f"wind_{p}",
        "vector",
        "m/s",
        "wind",
        ("pressure", p, f"{p} hPa"),
        _VRANGE[level],
    )


MSLP = FieldSpec("mslp", "mslp", "scalar", "hPa", "mslp", srange=(930.0, 1070.0))
T2M = FieldSpec("t2m", "t2m", "scalar", "°C", "t2m", srange=(-60.0, 60.0))
PRECIP = FieldSpec(
    "precip",
    "precip",
    "scalar",
    "mm per frame interval",
    "precip",
    srange=(0.0, 100.0),
    transform="sqrt",
)

ALL_FIELDS: List[FieldSpec] = (
    [_wind("10m")] + [_wind(str(p)) for p in PRESSURE_LEVELS] + [MSLP, T2M, PRECIP]
)
BY_SLUG = {f.slug: f for f in ALL_FIELDS}
GROUPS = ("wind", "mslp", "t2m", "precip")


def parse_levels(arg: Optional[str]) -> List[str]:
    """'10m,850,500' -> ['10m','850','500'] (validated, order of the catalogue)."""
    if not arg:
        return ["10m"] + [str(p) for p in PRESSURE_LEVELS]
    out = []
    for tok in arg.replace("hPa", "").replace("hpa", "").split(","):
        tok = tok.strip().lower()
        if tok in ("10", "10m"):
            tok = "10m"
        elif not tok.isdigit() or int(tok) not in PRESSURE_LEVELS:
            raise ValueError(f"unsupported level {tok!r}; use 10m or one of {PRESSURE_LEVELS}")
        out.append(tok)
    return [lv for lv in ["10m"] + [str(p) for p in PRESSURE_LEVELS] if lv in out]


def select(fields: Optional[str] = None, levels: Optional[str] = None) -> List[FieldSpec]:
    """`--fields wind,mslp,...` (or exact slugs/ids) and `--levels` (wind only) -> FieldSpecs."""
    lv = set(parse_levels(levels))
    toks = [t.strip() for t in (fields or ",".join(GROUPS)).split(",") if t.strip()]
    chosen: List[FieldSpec] = []
    for t in toks:
        if t in GROUPS:
            chosen += [f for f in ALL_FIELDS if f.group == t and (t != "wind" or _lv(f) in lv)]
        elif t in BY_SLUG:
            chosen.append(BY_SLUG[t])
        else:
            hit = [f for f in ALL_FIELDS if f.id == t]
            if not hit:
                raise ValueError(f"unknown field {t!r}; use {GROUPS} or a slug/id")
            chosen += hit
    seen, out = set(), []
    for f in chosen:
        if f.slug not in seen:
            seen.add(f.slug)
            out.append(f)
    if not out:
        raise ValueError("no fields selected")
    return out


def _lv(f: FieldSpec) -> str:
    return "10m" if f.level[0] == "height_agl" else str(f.level[1])


def frame_name(fhr: int) -> str:
    return f"f{fhr:03d}.png"


def names(specs: Sequence[FieldSpec]) -> List[str]:
    return [s.slug for s in specs]
