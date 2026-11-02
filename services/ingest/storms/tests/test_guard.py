import time
from datetime import datetime, timezone

from storms_ingest.cli import HOLD_EMPTY_FOR_S, suspicious_empty


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


NOW = time.time()
EMPTY = {"storms": []}
SOME = {"storms": [{"id": "WP302026"}]}


def test_empty_after_recent_nonempty_is_suspicious():
    assert suspicious_empty(EMPTY, {"count": 2, "updated": iso(NOW - 1800)}, NOW)


def test_nonempty_result_is_never_suspicious():
    assert not suspicious_empty(SOME, {"count": 2, "updated": iso(NOW - 600)}, NOW)


def test_empty_is_accepted_when_nothing_was_there_before():
    assert not suspicious_empty(EMPTY, None, NOW)
    assert not suspicious_empty(EMPTY, {"count": 0, "updated": iso(NOW - 600)}, NOW)


def test_empty_is_accepted_once_the_previous_run_is_old():
    assert not suspicious_empty(
        EMPTY, {"count": 2, "updated": iso(NOW - HOLD_EMPTY_FOR_S - 60)}, NOW
    )


def test_unreadable_previous_time_is_not_suspicious():
    assert not suspicious_empty(EMPTY, {"count": 2}, NOW)
    assert not suspicious_empty(EMPTY, {"count": 2, "updated": "garbage"}, NOW)
