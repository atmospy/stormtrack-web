import pytest
from hazards_ingest import sources
from hazards_ingest.validate import validate_collection

pytestmark = pytest.mark.network


def test_live_usgs():
    fc = sources.fetch_usgs()
    assert fc["features"] and validate_collection(fc, "quakes") == []


def test_live_eonet():
    fc = sources.fetch_eonet(30)
    assert fc["features"] and validate_collection(fc, "events") == []
