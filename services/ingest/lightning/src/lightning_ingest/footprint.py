"""Approximate GLM footprint.

GLM is a staring imager with ~8 km pixels at nadir degrading to ~14 km at the edge of the field
of view; NOAA and NASA state coverage out to about 52 deg N/S (goes-r.gov GLM page,
lightning.nsstc.nasa.gov GLM overview), and Rudlosky et al. (2019, GRL) quote 54 deg N/S. A pixel
that grows from 8 to 14 km corresponds to a local zenith angle of about 55 deg, i.e. a great-circle
distance of about 52-54 deg from the sub-satellite point. We therefore model the footprint of each
satellite as a spherical cap of radius ``RADIUS_DEG`` (52, the more conservative published figure)
centred on its nominal sub-satellite longitude on the equator, and union the caps of the satellites
in use. This is an approximation: detection efficiency falls off toward the edge, and the real
limit is not a perfect circle.
"""

from __future__ import annotations

import math

import numpy as np
from shapely.affinity import translate
from shapely.geometry import Polygon, box, mapping
from shapely.ops import unary_union

RADIUS_DEG = 52.0


def angular_distance_deg(lon, lat, lon0, lat0=0.0):
    lon, lat = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    lon0, lat0 = math.radians(lon0), math.radians(lat0)
    c = np.sin(lat) * math.sin(lat0) + np.cos(lat) * math.cos(lat0) * np.cos(lon - lon0)
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def _cap(lon0: float, radius: float = RADIUS_DEG, n: int = 180) -> Polygon:
    """Spherical cap on the equator at ``lon0`` as a polygon in unwrapped lon/lat degrees."""
    d = math.radians(radius)
    pts = []
    for i in range(n):
        b = 2 * math.pi * i / n
        lat = math.asin(math.sin(d) * math.cos(b))
        dlon = math.atan2(math.sin(b) * math.sin(d), math.cos(d))
        pts.append((lon0 + math.degrees(dlon), math.degrees(lat)))
    return Polygon(pts)


def _wrapped(poly: Polygon):
    world = box(-180, -90, 180, 90)
    parts = [poly.intersection(world)]
    minx, _, maxx, _ = poly.bounds
    if minx < -180:
        parts.append(translate(poly, xoff=360).intersection(world))
    if maxx > 180:
        parts.append(translate(poly, xoff=-360).intersection(world))
    return unary_union(parts)


def coverage_geojson(sub_lons: dict, radius: float = RADIUS_DEG) -> dict:
    """FeatureCollection with one (Multi)Polygon: union of the caps of the satellites in use."""
    geom = unary_union([_wrapped(_cap(lon, radius)) for lon in sub_lons.values()])
    m = mapping(geom)

    def r(c):
        return (
            [r(x) for x in c]
            if isinstance(c[0], (list, tuple))
            else [round(c[0], 2), round(c[1], 2)]
        )

    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "approximate": True,
                    "label": "Approximate GLM coverage (APPROXIMATE)",
                    "satellites": sorted(sub_lons),
                    "sub_satellite_lon": {k: round(v, 2) for k, v in sorted(sub_lons.items())},
                    "basis": (
                        f"Union of {radius:g} deg great-circle caps around each satellite's "
                        "sub-satellite point (NOAA/NASA quote GLM coverage to ~52 deg N/S). "
                        "Detection efficiency declines toward the edge."
                    ),
                },
                "geometry": {"type": m["type"], "coordinates": r(m["coordinates"])},
            }
        ],
    }
