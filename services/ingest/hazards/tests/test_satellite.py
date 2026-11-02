from __future__ import annotations

import json

import pytest
from hazards_ingest import satellite

JPEG = b"\xff\xd8\xff\xe0" + b"x" * 60_000  # looks like a JPEG and is large enough
NOW = "2026-11-02T15:00:00Z"


def test_url_requests_the_exact_extent_in_degrees_as_jpeg():
    u = satellite.url()
    assert "layers=imd_ws:insat_ctbt1" in u and "srs=EPSG:4326" in u and "format=image/jpeg" in u
    assert "bbox=44.4811,-10.0219,105.5012,45.5133" in u and "width=1600&height=1456" in u


def test_check_image_rejects_errors_and_tiny_files():
    satellite.check_image(JPEG)
    with pytest.raises(ValueError, match="not a JPEG"):
        satellite.check_image(b"<ServiceExceptionReport>" + b"x" * 80_000)
    with pytest.raises(ValueError, match="bytes"):
        satellite.check_image(b"\xff\xd8\xff" + b"x" * 100)


def test_changed_at_moves_only_when_the_image_changes():
    first = satellite.build_meta(JPEG, None, "2026-11-02T14:00:00Z")
    assert first["changed_at"] == "2026-11-02T14:00:00Z" and first["bounds"] == list(
        satellite.BOUNDS
    )
    same = satellite.build_meta(JPEG, first, NOW)
    assert same["changed_at"] == "2026-11-02T14:00:00Z" and same["generated"] == NOW
    new = satellite.build_meta(JPEG + b"1", first, NOW)
    assert new["changed_at"] == NOW and new["sha256"] != first["sha256"]
    assert new["attribution"].endswith("(IMD)") and "no licence" in new["licence"]


def test_main_writes_image_then_pointer_and_keeps_changed_at(tmp_path):
    assert (
        satellite.main(["--out", str(tmp_path)], fetch=lambda: JPEG, now="2026-11-02T14:00:00Z")
        == 0
    )
    d = tmp_path / "satellite"
    assert (d / "insat-ir.jpg").read_bytes() == JPEG
    assert json.loads((d / "insat-ir.json").read_text())["changed_at"] == "2026-11-02T14:00:00Z"
    assert (
        satellite.main(["--out", str(tmp_path)], fetch=lambda: JPEG, now=NOW) == 0
    )  # same bytes, later poll
    assert json.loads((d / "insat-ir.json").read_text())["changed_at"] == "2026-11-02T14:00:00Z"


def test_failure_leaves_the_previous_files_untouched(tmp_path):
    d = tmp_path / "satellite"
    d.mkdir()
    (d / "insat-ir.jpg").write_bytes(b"previous image")
    (d / "insat-ir.json").write_text("previous meta")
    assert (
        satellite.main(["--out", str(tmp_path)], fetch=lambda: b"<html>error</html>", now=NOW) == 1
    )
    assert (
        satellite.main(
            ["--out", str(tmp_path)],
            fetch=lambda: (_ for _ in ()).throw(RuntimeError("down")),
            now=NOW,
        )
        == 1
    )
    assert (d / "insat-ir.jpg").read_bytes() == b"previous image" and (
        d / "insat-ir.json"
    ).read_text() == "previous meta"
