from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from hazards_ingest import nowcast

NOW = datetime(2026, 11, 2, 14, 45, tzinfo=timezone.utc)  # 20:15 Indian time


def square(x, y, n=40):
    """A closed ring of many near-collinear points, so simplification has work to do."""
    pts = [(x + i * 0.01, y) for i in range(n)] + [(x + n * 0.01, y + i * 0.01) for i in range(n)]
    pts += [(x + (n - i) * 0.01, y + n * 0.01) for i in range(n)] + [
        (x, y + (n - i) * 0.01) for i in range(n + 1)
    ]
    return [[list(p) for p in pts]]


def feat(name, color, ws, date="2026-11-02", toi=1900, vupto=2200, coords=None):
    return {
        "type": "Feature",
        "geometry": {"type": "MultiPolygon", "coordinates": [coords or square(85.0, 21.0)]},
        "properties": {
            "State_District": name,
            "Date": date,
            "toi": toi,
            "vupto": vupto,
            "ws_cond": ws,
            "color_hex": color,
        },
    }


FEATS = [
    feat("MORBI", "#228b22", "No Warning$$$$#"),
    feat("ALAPPUZHA", "#ffbf00", "$Light rain: < 5 mm/hr$$$$#"),
    feat(
        "BARAGARH",
        "#ff7900",
        "$$$$Moderate rain: 5-15 mm/hr$$Moderate Thunderstorms with gusts$$Lightning 30 - 60%$$#",
    ),
    feat("MAHE", "#228b22", "$$$#No Data Available", date="2023-06-27", toi=1000, vupto=1300),
    feat("OLDONE", "#ffbf00", "$Light rain$#", toi=1000, vupto=1300),  # expired three hours ago
]


def body(feats=FEATS) -> bytes:
    return json.dumps({"type": "FeatureCollection", "features": feats}).encode()


def test_levels_follow_imd_colours():
    assert (
        nowcast.level_for("#228b22") is None
        and nowcast.level_for("") is None
        and nowcast.level_for(None) is None
    )
    assert nowcast.level_for("#ffbf00") == 1 and nowcast.level_for("#FF7900") == 2
    assert nowcast.level_for("#ff0000") == 3  # any other non-green colour is the top level


def test_warning_texts_split_on_dollar_and_drop_placeholders():
    t = nowcast.warning_texts("$$$$Moderate rain: 5-15 mm/hr$$Moderate Thunderstorms with gusts$$#")
    assert t == ["Moderate rain: 5-15 mm/hr", "Moderate Thunderstorms with gusts"]
    assert (
        nowcast.warning_texts("No Warning$$$#") == []
        and nowcast.warning_texts("$$#No Data Available") == []
    )


def test_window_is_indian_time_and_rolls_past_midnight():
    issued, until = nowcast.window("2026-11-02", 1900, 2200)
    assert (
        issued.astimezone(timezone.utc).hour == 13 and issued.astimezone(timezone.utc).minute == 30
    )
    assert (until - issued).total_seconds() == 3 * 3600
    _, late = nowcast.window("2026-11-02", 2230, 100)
    assert late.day == 3  # valid up to 01:00 the next day


def test_simplify_keeps_end_points_and_drops_collinear_points():
    line = [(0, 0), (1, 0.0001), (2, 0), (3, 0.0002), (4, 0)]
    assert nowcast.simplify(line, 0.01) == [(0, 0), (4, 0)]
    kink = [(0, 0), (2, 1), (4, 0)]
    assert nowcast.simplify(kink, 0.01) == kink  # a real corner stays
    assert nowcast.simplify([(0, 0), (1, 1)], 0.01) == [(0, 0), (1, 1)]


def test_build_keeps_only_current_warned_districts_and_shrinks_shapes():
    fc = nowcast.build(nowcast.parse(body()), NOW)
    names = [f["properties"]["district"] for f in fc["features"]]
    assert names == [
        "Baragarh",
        "Alappuzha",
    ]  # highest level first; green, no-data and expired are out
    assert fc["counts"] == {"light": 1, "moderate": 1, "severe": 0}
    assert fc["districts_in_service"] == 5 and fc["stale"] is False
    f = fc["features"][0]
    assert f["properties"]["level"] == 2 and len(f["properties"]["warnings"]) == 3
    assert f["properties"]["valid_until"] == "2026-11-02T16:30:00Z"  # 22:00 Indian time
    ring = f["geometry"]["coordinates"][0][0]
    assert ring[0] == ring[-1] and len(ring) < 20  # was 161 points; only the corners remain
    assert fc["attribution"].endswith("(IMD)")


def test_stale_service_is_flagged():
    old = [feat("X", "#ffbf00", "$Light rain$#", date="2026-11-01")]
    fc = nowcast.build(nowcast.parse(body(old)), NOW)
    assert fc["stale"] is True and fc["features"] == []


def test_parse_rejects_a_changed_service():
    for bad in (
        b"<html>",
        b'{"type": "x"}',
        b'{"features": []}',
        json.dumps({"features": [{"properties": {"id": 1}}]}).encode(),
    ):
        with pytest.raises(ValueError):
            nowcast.parse(bad)


def test_failure_leaves_the_previous_file_untouched(tmp_path):
    p = tmp_path / "nowcast" / "latest.geojson"
    p.parent.mkdir()
    p.write_text("previous")
    assert nowcast.main(["--out", str(tmp_path)], fetch=lambda: b"<html>moved</html>", now=NOW) == 1
    assert p.read_text() == "previous"
    assert (
        nowcast.main(
            ["--out", str(tmp_path)],
            fetch=lambda: (_ for _ in ()).throw(RuntimeError("down")),
            now=NOW,
        )
        == 1
    )
    assert p.read_text() == "previous"


def test_main_writes_the_file(tmp_path):
    assert nowcast.main(["--out", str(tmp_path)], fetch=lambda: body(), now=NOW) == 0
    d = json.loads((tmp_path / "nowcast" / "latest.geojson").read_text())
    assert len(d["features"]) == 2 and d["counts"]["moderate"] == 1
