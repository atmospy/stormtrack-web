"""INSAT infrared satellite image from IMD's public map service (UNDOCUMENTED) -> ``satellite/insat-ir.jpg``.

IMD's public GeoServer serves ``imd_ws:insat_ctbt1``, the INSAT infrared image (bright = cold cloud
top) for the satellite's whole field of view, 44.48 to 105.50 E and 10.02 S to 45.51 N (the extent in the
service's capabilities). A WMS GetMap for exactly that box in EPSG:4326 returns the image with no empty
margin: 1600 x 1456 pixels, about 340 kB as JPEG. The box is part of OUR request, so the picture is
georeferenced by what we asked for. The service gives no acquisition time, so the file records when we
fetched it and when its bytes last changed (a lower bound on the satellite's update, to within one poll).

IMD publishes no terms for this service. It is read here once per run from a descriptive User-Agent
(never by visitors' browsers), and the output credits IMD. A failed or unrecognisable response leaves
the previous files untouched.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import urllib.request
from pathlib import Path

from .common import UA, atomic_write_bytes, http_get, now_iso

log = logging.getLogger("ingest-satellite")

BOUNDS = (44.4811, -10.0219, 105.5012, 45.5133)  # west, south, east, north
SIZE = (1600, 1456)
LAYER = "imd_ws:insat_ctbt1"
BASE = "https://hgmg.imd.gov.in:8443/geoserver/imd_ws/wms"
IMAGE_NAME = "insat-ir.jpg"
META_NAME = "insat-ir.json"
MIN_BYTES = 50_000  # a WMS error comes back as a few hundred bytes of XML
LICENCE = "IMD publishes no licence or terms for this service; credit the India Meteorological Department"
ATTRIBUTION = "Satellite image: INSAT, India Meteorological Department (IMD)"


def url() -> str:
    w, s, e, n = BOUNDS
    return (
        f"{BASE}?service=WMS&version=1.1.1&request=GetMap&layers={LAYER}&styles=&srs=EPSG:4326"
        f"&bbox={w},{s},{e},{n}&width={SIZE[0]}&height={SIZE[1]}&format=image/jpeg"
    )


def check_image(data: bytes) -> None:
    """Raise ValueError unless ``data`` looks like a real JPEG of plausible size."""
    if not data.startswith(b"\xff\xd8\xff"):
        raise ValueError("response is not a JPEG (an error message from the service?)")
    if len(data) < MIN_BYTES:
        raise ValueError(f"image is only {len(data)} bytes (blank or truncated?)")


def build_meta(data: bytes, prev: dict | None, now: str) -> dict:
    """Metadata for the published image; ``changed_at`` moves only when the bytes change."""
    sha = hashlib.sha256(data).hexdigest()
    unchanged = bool(prev) and prev.get("sha256") == sha and isinstance(prev.get("changed_at"), str)
    return {
        "schema": 1,
        "generated": now,
        "image": IMAGE_NAME,
        "bounds": list(BOUNDS),
        "width": SIZE[0],
        "height": SIZE[1],
        "bytes": len(data),
        "sha256": sha,
        "changed_at": prev["changed_at"] if unchanged else now,
        "source": "IMD INSAT infrared (public map service, unofficial access)",
        "attribution": ATTRIBUTION,
        "licence": LICENCE,
        "note": (
            "Infrared image, bright means cold cloud tops. The service gives no acquisition time: "
            "'changed_at' is when we first saw this image, so the satellite scan is at or before it."
        ),
    }


def _read_prev(out: Path, base_url: str | None) -> dict | None:
    local = out / "satellite" / META_NAME
    if local.exists():
        try:
            return json.loads(local.read_text())
        except ValueError:
            return None
    if not base_url:
        return None
    try:
        req = urllib.request.Request(base_url.rstrip("/") + f"/satellite/{META_NAME}", headers=UA)
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310
            d = json.loads(r.read())
        return d if isinstance(d, dict) else None
    except Exception as exc:  # noqa: BLE001 - no previous meta just means 'changed now'
        log.warning("could not read previous satellite meta: %s", exc)
        return None


def main(argv=None, fetch=None, now=None) -> int:
    ap = argparse.ArgumentParser(prog="ingest-satellite", description=__doc__)
    ap.add_argument("--out", default=os.environ.get("PUBLIC_DATA_DIR", "public-data"), help="public-data directory")
    ap.add_argument("--prev-url", default=None, help="public data base URL, to keep changed_at on a stateless runner")
    ap.add_argument("--upload", action="store_true", help="upload to R2 (needs R2_* env vars)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    out = Path(a.out)
    try:
        data = (fetch or (lambda: http_get(url(), timeout=90)))()
        check_image(data)
    except Exception as exc:  # noqa: BLE001 - leave the previous files in place
        log.error("satellite failed, previous files untouched: %s", exc)
        return 1
    meta = build_meta(data, _read_prev(out, a.prev_url), now or now_iso())
    d = out / "satellite"
    atomic_write_bytes(d / IMAGE_NAME, data)
    atomic_write_bytes(d / META_NAME, json.dumps(meta, separators=(",", ":")).encode())  # pointer LAST
    log.info("satellite: %.0f kB, changed_at %s", len(data) / 1e3, meta["changed_at"])
    if a.upload:
        from .upload import upload_files

        log.info("uploaded %d objects", len(upload_files(out, [f"satellite/{IMAGE_NAME}", f"satellite/{META_NAME}"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
