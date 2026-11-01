"""Run the real pipeline pieces on the committed datasets (offline) and check budgets."""
import gzip
import json

import pytest

from storms_ingest import cli
from storms_ingest.validate import validate_history, validate_index, validate_stats

DATA = "/Users/syed44/Git_Stuff/Git_Projects/imdtrack/data"


@pytest.fixture(scope="module")
def out(tmp_path_factory):
    import os

    if not os.path.isdir(DATA):
        pytest.skip("stormtrack data dir not available")
    os.environ["STORMTRACK_DATA_DIR"] = DATA
    out = tmp_path_factory.mktemp("pub")
    assert cli.main(["--out", str(out), "--only", "history"]) == 0
    return out


def test_history_stats_index(out):
    h = json.loads((out / "storms/history/NI.geojson").read_text())
    assert validate_history(h) == []
    assert len(h["features"]) > 1500
    assert len(gzip.compress((out / "storms/history/NI.geojson").read_bytes())) < 1_500_000
    s = json.loads((out / "storms/stats/NI.json").read_text())
    assert validate_stats(s) == []
    ix = json.loads((out / "storms/index.json").read_text())
    assert validate_index(ix) == [] and ix["history"]["NI"]["count"] == len(h["features"])
    assert ix["history"]["NI"]["sources"] == ["IMD", "IBTrACS"]


def test_files_world_readable(out):
    assert (out / "storms/index.json").stat().st_mode & 0o004


def test_index_not_written_when_nothing_succeeds(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "run_history", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    assert cli.main(["--out", str(tmp_path), "--only", "history"]) == 1
    assert not (tmp_path / "storms/index.json").exists()


def test_upload_to_mocked_s3(out):
    boto3 = pytest.importorskip("boto3")
    moto = pytest.importorskip("moto")
    from storms_ingest.upload import upload_files

    env = {"R2_ACCESS_KEY_ID": "k", "R2_SECRET_ACCESS_KEY": "s", "R2_BUCKET": "test-bucket", "R2_ENDPOINT": "https://s3.us-east-1.amazonaws.com", "R2_PREFIX": "pub"}
    with moto.mock_aws():
        c = boto3.client("s3", region_name="us-east-1", aws_access_key_id="k", aws_secret_access_key="s")
        c.create_bucket(Bucket="test-bucket")
        keys = upload_files(out, ["storms/history/NI.geojson", "storms/index.json"], client=c, env=env)
        assert keys == ["pub/storms/history/NI.geojson", "pub/storms/index.json"]
        o = c.get_object(Bucket="test-bucket", Key="pub/storms/index.json")
        assert o["ContentType"] == "application/json" and "max-age" in o["CacheControl"]
        assert json.loads(o["Body"].read())["schema"] == 1


def test_make_client_requires_env():
    from storms_ingest.upload import make_client

    with pytest.raises(RuntimeError):
        make_client({})
