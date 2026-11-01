"""Live test: downloads a few recent GLM files. Run with ``pytest -m network``."""

from __future__ import annotations

import time

import pytest
from lightning_ingest import pipeline
from lightning_ingest.schema import validate_all


@pytest.mark.network
def test_live_recent_files(tmp_path):
    from lightning_ingest.sources.goes_glm import GoesGlm

    res = pipeline.run(
        tmp_path,
        window_min=5,
        sources=[GoesGlm(satellites=["G18", "G19"], max_files=12)],
        now=time.time(),
    )
    assert res["ok"], res["errors"]
    import json

    d = tmp_path / "lightning"
    idx, fl, cov = (
        json.loads((d / n).read_text()) for n in ("index.json", "flashes.json", "coverage.geojson")
    )
    assert validate_all(idx, fl, cov) == []
    assert res["files"] > 0 and idx["count"] > 0


@pytest.mark.network
def test_live_iitm_single_request():
    """ONE polite request to the unofficial IITM feed. Run at most twice in total, >= 5 min apart."""
    from lightning_ingest.sources.iitm_damini import IitmDamini

    now = time.time()
    b = IitmDamini().poll(None, now, 3600)
    assert not b.failed, b.errors
    assert len(b.t) == len(b.lon) == len(b.lat)
    assert (b.lat >= 0).all() and (b.lat <= 45).all()
    assert (b.t <= now).all() and (b.t >= now - 15 * 60).all()
    print("IITM live:", len(b.t), "strikes, skew", b.state.get("clock_skew_s"))
