"""Build static/boundaries-india.geojson: shared land borders between countries as drawn from India's
point of view (Natural Earth `ne_10m_admin_0_countries_ind`, public domain), simplified for the web.

India's official map includes all of Jammu & Kashmir (incl. Gilgit-Baltistan), Ladakh (incl. Aksai Chin)
and Arunachal Pradesh. The OpenStreetMap-based basemap draws those borders differently, so the app hides
its own country borders and draws these instead.

Usage: uv run --with shapely python scripts/make-boundaries.py <ne_10m_admin_0_countries_ind.geojson> static/boundaries-india.geojson
"""
import json
import sys

from shapely.geometry import MultiLineString, mapping, shape
from shapely.ops import linemerge, unary_union

src, out = sys.argv[1], sys.argv[2]
feats = json.load(open(src))["features"]
geoms = []
for f in feats:
    g = shape(f["geometry"]).buffer(0)
    geoms.append((f["properties"].get("ADM0_A3") or f["properties"].get("ISO_A3"), g))

lines = []
for i in range(len(geoms)):
    for j in range(i + 1, len(geoms)):
        a, b = geoms[i][1], geoms[j][1]
        if not a.envelope.buffer(0.01).intersects(b.envelope):
            continue
        shared = a.boundary.intersection(b.boundary.buffer(1e-6))
        if shared.is_empty:
            continue
        lines.append(shared)
merged = linemerge(unary_union(lines)) if lines else MultiLineString()
simple = merged.simplify(0.01, preserve_topology=False)
parts = [simple] if simple.geom_type == "LineString" else list(simple.geoms)
parts = [p for p in parts if p.length > 0.05 and p.geom_type == "LineString"]


def rnd(c):
    return [round(c[0], 3), round(c[1], 3)]


fc = {
    "type": "FeatureCollection",
    "properties": {
        "source": "Natural Earth ne_10m_admin_0_countries_ind (India point of view), public domain",
        "note": "Borders as shown on India's official map. Not a legal boundary document.",
    },
    "features": [
        {"type": "Feature", "properties": {}, "geometry": {"type": "LineString", "coordinates": [rnd(c) for c in p.coords]}}
        for p in parts
    ],
}
json.dump(fc, open(out, "w"), separators=(",", ":"))
print(len(parts), "lines")
