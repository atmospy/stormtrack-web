"""FastAPI app: /healthz, /v1/storms/active, /v1/storms/{id}/summary."""

from __future__ import annotations

import os
from typing import Callable, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import service

ACTIVE_TTL = float(os.environ.get("ACTIVE_TTL_SECONDS", "300"))
SUMMARY_TTL = float(os.environ.get("SUMMARY_TTL_SECONDS", "3600"))


def _default_fetch_active(src: str):
    import stormtrack as st

    return st.realtime.active_storms(src)


def _default_history():
    import stormtrack as st

    return st.load_ibtracs().observations


def create_app(fetch_active: Optional[Callable] = None, load_history: Optional[Callable] = None) -> FastAPI:
    """``fetch_active(src)`` / ``load_history()`` are injectable for tests."""
    fetch_active = fetch_active or _default_fetch_active
    load_history = load_history or _default_history
    cache = service.TTLCache()
    app = FastAPI(title="StormTrack API", version="0.1.0")
    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    if origins:  # no CORS headers at all unless origins are configured
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET"], allow_headers=["*"],
                           allow_credentials=False, max_age=3600)

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.get("/v1/storms/active")
    def active():
        return cache.get_or_set("active", ACTIVE_TTL, lambda: service.active_geojson(fetch_active))

    @app.get("/v1/storms/{storm_id}/summary")
    def summary(storm_id: str):
        if not storm_id.isalnum() or len(storm_id) > 20:
            raise HTTPException(422, "invalid storm id")

        def compute():
            hist = cache.get_or_set("history", 86400, load_history)
            if (hist["storm_id"] == storm_id).any():
                return service.summarize(hist, storm_id, None, "IBTrACS (North Indian Ocean)")
            for src in ("nhc", "jtwc"):
                try:
                    bt = fetch_active(src)
                except Exception:  # noqa: BLE001
                    continue
                if (bt.observations["storm_id"] == storm_id).any():
                    return service.summarize(bt.observations, storm_id, 1, f"ATCF {src.upper()} best track (active)")
            return None

        result = cache.get_or_set(("summary", storm_id), SUMMARY_TTL, compute)
        if result is None:
            raise HTTPException(404, f"unknown storm {storm_id}")
        return result

    return app


app = create_app()
