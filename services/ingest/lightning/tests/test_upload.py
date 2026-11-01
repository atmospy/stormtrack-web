from __future__ import annotations

import boto3
import pytest
from lightning_ingest import upload
from moto import mock_aws

ENV = {
    "R2_ACCOUNT_ID": "acct",
    "R2_ACCESS_KEY_ID": "k",
    "R2_SECRET_ACCESS_KEY": "s",
    "R2_BUCKET": "bkt",
    "R2_PREFIX": "pub",
}


@mock_aws
def test_upload_headers_and_order(tmp_path, monkeypatch):
    d = tmp_path / "lightning"
    d.mkdir()
    for n in ("flashes.json", "coverage.geojson", "index.json"):
        (d / n).write_text("{}")
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="bkt")
    keys = upload.upload_files(
        tmp_path,
        ["lightning/flashes.json", "lightning/coverage.geojson", "lightning/index.json"],
        client=s3,
        env=ENV,
    )
    assert keys[-1] == "pub/lightning/index.json"
    h = s3.head_object(Bucket="bkt", Key="pub/lightning/flashes.json")
    assert h["CacheControl"] == "public, max-age=30, stale-while-revalidate=60"
    assert h["ContentType"] == "application/json"
    h = s3.head_object(Bucket="bkt", Key="pub/lightning/index.json")
    assert "max-age=30" in h["CacheControl"]
    h = s3.head_object(Bucket="bkt", Key="pub/lightning/coverage.geojson")
    assert (
        h["CacheControl"] == "public, max-age=3600" and h["ContentType"] == "application/geo+json"
    )


def test_missing_env_raises():
    with pytest.raises(RuntimeError, match="R2_ACCESS_KEY_ID"):
        upload.make_client({"R2_ACCOUNT_ID": "a"})
