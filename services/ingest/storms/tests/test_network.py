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
