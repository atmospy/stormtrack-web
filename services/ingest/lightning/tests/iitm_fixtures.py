"""Real-shape page fixtures for the IITM Damini source (no network)."""

from __future__ import annotations

import json

PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Lightning India</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/></head>
<body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const map = L.map('map').setView([22, 80], 5);
  const lightningData = %s;
  lightningData.forEach(function (p) { L.circleMarker([p.lat, p.lng]).addTo(map); });
</script></body></html>
"""


def page(items) -> bytes:
    """items: list of (lat, lng, label) or raw dicts."""
    data = [
        {"lat": f"{i[0]:.4f}", "lng": f"{i[1]:.4f}", "label": i[2]} if isinstance(i, tuple) else i
        for i in items
    ]
    return (PAGE % json.dumps(data)).encode()


class FakeFetcher:
    """Stands in for the HTTP client; records every request."""

    def __init__(self, body=b"", headers=None, exc=None):
        self.body, self.headers, self.exc = body, headers or {}, exc
        self.calls = 0

    def get(self, url):
        self.calls += 1
        if self.exc is not None:
            raise self.exc
        return self.body, self.headers
