import pytest

pytestmark = pytest.mark.network


def test_live_active_and_validate():
    from storms_ingest.active import build_active
    from storms_ingest.validate import validate_active

    coll, rep = build_active(None)
    assert rep["ok"], rep
    assert validate_active(coll) == []


def test_live_cone_radii():
    """Uses the real cache dir (a cold run downloads ~60 multi-MB a-decks: ~25 min)."""
    from storms_ingest import cone
    from storms_ingest.cli import DEFAULT_CACHE

    r = cone.build_radii(DEFAULT_CACHE, 2)
    assert r["radii_km"] and r["n_errors"] > 1000


def test_live_wp_history_downloads_and_validates(tmp_path):
    """Downloads the WP NCEI CSV (115 MB) into the real cache on a cold machine."""
    import gzip
    import json

    from storms_ingest import cli
    from storms_ingest.validate import (
        validate_all_index,
        validate_history,
        validate_index,
        validate_stats,
    )

    cache = cli.DEFAULT_CACHE / "ibtracs"
    assert cli.main(["--out", str(tmp_path), "--only", "history", "--basin", "WP"]) == 0
    s = tmp_path / "storms"
    h = json.loads((s / "history/WP.geojson").read_text())
    assert validate_history(h, "WP") == [] and len(h["features"]) > 3500
    assert len(gzip.compress((s / "history/WP.geojson").read_bytes())) < 1_500_000
    assert validate_stats(json.loads((s / "stats/WP.json").read_text())) == []
    assert validate_index(json.loads((s / "index.json").read_text())) == []
    assert validate_all_index(json.loads((s / "history/all-index.json").read_text())) == []
    names = {f["properties"]["name"]: f["properties"] for f in h["features"]}
    assert names["HAIYAN"]["max_wind_kt"] >= 150 and cache.exists()
