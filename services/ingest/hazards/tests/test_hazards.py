import json
import math
from pathlib import Path

import pytest

from hazards_ingest import cli, sources
from hazards_ingest.validate import validate_collection, validate_index

FIX = Path(__file__).parent / "fixtures"


def eonet():
    return sources.normalize_eonet(json.loads((FIX / "eonet.json").read_text()))


def usgs():
    return sources.normalize_usgs(json.loads((FIX / "usgs.json").read_text()))


def firms(**kw):
    return sources.normalize_firms((FIX / "firms.csv").read_text(), **kw)


def test_eonet_contract_and_kinds():
    fc = eonet()
    assert validate_collection(fc, "events") == []
    kinds = {f["properties"]["kind"] for f in fc["features"]}
    assert "wildfire" in kinds and kinds <= {"wildfire", "volcano", "quake", "flood", "storm", "other"}
    assert all(f["properties"]["source"] == "NASA EONET" and f["properties"]["url"] for f in fc["features"])
    assert fc["attribution"] == "NASA EONET"


def test_eonet_mapping_and_polygon_centroid():
    raw = {"events": [
        {"id": "E1", "title": "Mt X", "link": "l", "categories": [{"id": "volcanoes"}], "sources": [{"id": "SIVolcano", "url": "u"}],
         "geometry": [{"date": "2026-10-01T00:00:00Z", "type": "Point", "coordinates": [10, 20]}]},
        {"id": "E2", "title": "Flood", "link": "l", "categories": [{"id": "floods"}], "sources": [],
         "geometry": [{"date": "2026-10-01T00:00:00Z", "type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]},
                      {"date": "2026-09-01T00:00:00Z", "type": "Point", "coordinates": [50, 50]}]},
        {"id": "E3", "title": "Ice", "link": "l", "categories": [{"id": "seaLakeIce"}], "sources": [],
         "geometry": [{"date": "2026-10-01T00:00:00Z", "type": "Point", "coordinates": [300, 20]}]},  # bad lon: dropped
    ]}
    fc = sources.normalize_eonet(raw)
    by = {f["properties"]["id"]: f for f in fc["features"]}
    assert by["E1"]["properties"]["kind"] == "volcano" and "E3" not in by
    assert by["E2"]["properties"]["kind"] == "flood" and by["E2"]["geometry"]["coordinates"] == [0.8, 0.8]  # latest geometry, centroid


def test_usgs():
    fc = usgs()
    assert validate_collection(fc, "quakes") == []
    f = fc["features"][0]["properties"]
    assert f["source"] == "USGS" and f["time"].endswith("Z") and f["mag"] >= 2.5 and f["url"].startswith("https://earthquake.usgs.gov")


def test_firms_dedupe_and_cap():
    fc = firms()
    assert validate_collection(fc, "fires") == []
    assert len(fc["features"]) == 2 and fc["raw_detections"] == 3  # two near-identical detections merged
    top = fc["features"][0]["properties"]
    assert top["frp"] == 40.0 and top["confidence"] == "high" and top["detections"] == 2
    assert top["time"] == "2026-11-01T03:47:00Z"
    big = "latitude,longitude,acq_date,acq_time,confidence,frp\n" + "\n".join(
        f"{(i % 300) / 4 - 40:.4f},{(i // 300) / 4 - 90:.4f},2026-11-01,0100,n,{i % 50}" for i in range(60000))
    capped = sources.normalize_firms(big, max_points=20000)
    assert len(capped["features"]) <= 20000 and capped["grid_deg"] >= 0.05


def test_firms_error_text_is_not_leaked():
    def get(url, timeout=0):
        return b"Invalid MAP_KEY."

    with pytest.raises(RuntimeError) as e:
        sources.fetch_firms("SECRETKEY", get=get)
    assert "SECRETKEY" not in str(e.value)


def run(tmp_path, fetchers, env=None):
    return cli.main(["--out", str(tmp_path)], env=env or {}, fetchers=fetchers)


def test_cli_partial_failure_exit_zero_and_index_last(tmp_path):
    def boom():
        raise RuntimeError("EONET down")

    assert run(tmp_path, {"events": boom, "quakes": usgs}) == 0
    ix = json.loads((tmp_path / "hazards/index.json").read_text())
    assert validate_index(ix) == [] and "events" in ix["failed"] and ix["layers"]["quakes"]["count"] > 0
    assert not (tmp_path / "hazards/events.geojson").exists()
    assert ix["layers"]["quakes"]["source"] == "USGS" and ix["layers"]["quakes"]["url"]


def test_cli_total_failure_nonzero_and_no_index(tmp_path):
    def boom():
        raise RuntimeError("down")

    assert run(tmp_path, {"events": boom, "quakes": boom}) == 1
    assert not (tmp_path / "hazards/index.json").exists()


def test_cli_failed_layer_keeps_previous_file(tmp_path):
    assert run(tmp_path, {"events": eonet, "quakes": usgs}) == 0
    before = (tmp_path / "hazards/events.geojson").read_bytes()

    def boom():
        raise RuntimeError("x")

    assert run(tmp_path, {"events": boom, "quakes": usgs}) == 0
    assert (tmp_path / "hazards/events.geojson").read_bytes() == before
    assert json.loads((tmp_path / "hazards/index.json").read_text())["layers"]["events"]["stale"] is True


def test_cli_no_firms_key_means_no_fires_file(tmp_path, monkeypatch):
    monkeypatch.setattr(sources, "fetch_eonet", lambda days=30, get=None: eonet())
    monkeypatch.setattr(sources, "fetch_usgs", lambda get=None: usgs())
    assert cli.main(["--out", str(tmp_path)], env={}) == 0
    assert not (tmp_path / "hazards/fires.geojson").exists()
    monkeypatch.setattr(sources, "fetch_firms", lambda key, days=1, product=None, get=None: firms())
    assert cli.main(["--out", str(tmp_path)], env={"FIRMS_MAP_KEY": "k"}) == 0
    ix = json.loads((tmp_path / "hazards/index.json").read_text())
    assert set(ix["layers"]) == {"events", "quakes", "fires"}


def test_upload_mocked_s3(tmp_path):
    boto3 = pytest.importorskip("boto3")
    moto = pytest.importorskip("moto")
    env = {"R2_ACCESS_KEY_ID": "k", "R2_SECRET_ACCESS_KEY": "s", "R2_BUCKET": "test-bucket",
           "R2_ENDPOINT": "https://s3.us-east-1.amazonaws.com"}
    with moto.mock_aws():
        c = boto3.client("s3", region_name="us-east-1", aws_access_key_id="k", aws_secret_access_key="s")
        c.create_bucket(Bucket="test-bucket")
        from hazards_ingest import upload

        monkey = upload.make_client
        upload.make_client = lambda env=None: c
        try:
            assert cli.main(["--out", str(tmp_path), "--upload"], env=env, fetchers={"quakes": usgs}) == 0
        finally:
            upload.make_client = monkey
        keys = [o["Key"] for o in c.list_objects_v2(Bucket="test-bucket")["Contents"]]
        assert keys == ["hazards/index.json", "hazards/quakes.geojson"] or set(keys) == {"hazards/index.json", "hazards/quakes.geojson"}
        assert c.get_object(Bucket="test-bucket", Key="hazards/quakes.geojson")["ContentType"] == "application/geo+json"
