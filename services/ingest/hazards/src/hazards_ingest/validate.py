"""Validators for CONTRACTS section 3."""

from __future__ import annotations

import re

KINDS = {"wildfire", "volcano", "quake", "flood", "storm", "other"}
ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def validate_collection(fc: dict, layer: str) -> list:
    errs = []
    if fc.get("type") != "FeatureCollection":
        return ["not a FeatureCollection"]
    seen = set()
    for i, f in enumerate(fc["features"]):
        p, g, w = f["properties"], f["geometry"], f"{layer}[{i}]"
        if g.get("type") != "Point" or not (-180 <= g["coordinates"][0] <= 180 and -90 <= g["coordinates"][1] <= 90):
            errs.append(f"{w}: bad geometry")
        for k in ("id", "kind", "title", "time", "url", "source"):
            if k not in p:
                errs.append(f"{w}: missing {k}")
        if p.get("kind") not in KINDS:
            errs.append(f"{w}: bad kind {p.get('kind')}")
        if not (isinstance(p.get("time"), str) and ISO_Z.match(p["time"])):
            errs.append(f"{w}: bad time {p.get('time')}")
        if not p.get("source"):
            errs.append(f"{w}: empty source")
        if p.get("id") in seen:
            errs.append(f"{w}: duplicate id")
        seen.add(p.get("id"))
        if layer == "quakes" and not (isinstance(p.get("mag"), (int, float)) and "depth_km" in p and p["mag"] >= 2.4):  # USGS feed threshold applies to rounded magnitude (2.45 appears)
            errs.append(f"{w}: quake mag/depth_km")
        if layer == "fires" and ("frp" not in p or "confidence" not in p):
            errs.append(f"{w}: fire frp/confidence")
    if layer == "fires" and len(fc["features"]) > 20_000:
        errs.append("fires exceeds 20k points")
    return errs


def validate_index(ix: dict) -> list:
    errs = []
    if ix.get("schema") != 1 or not ISO_Z.match(str(ix.get("generated"))):
        errs.append("schema/generated")
    if not isinstance(ix.get("layers"), dict) or not ix["layers"]:
        errs.append("layers")
    for name, l in ix.get("layers", {}).items():
        if not {"count", "source"} <= set(l):
            errs.append(f"layer {name}")
    return errs
