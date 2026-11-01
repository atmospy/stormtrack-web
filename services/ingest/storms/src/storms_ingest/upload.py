"""Upload files to Cloudflare R2 (S3-compatible) via boto3.

Environment (no credentials in code):
  R2_ACCOUNT_ID         used to build https://<id>.r2.cloudflarestorage.com (or set R2_ENDPOINT)
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
  R2_ENDPOINT           optional full endpoint URL override
  R2_PREFIX             optional key prefix (default: none; keys mirror public-data/ paths)
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable

CONTENT_TYPES = {".geojson": "application/geo+json", ".json": "application/json"}
# short cache for pointers/live data, longer for slow-changing history & stats
CACHE = {"index.json": "public, max-age=60", "active.geojson": "public, max-age=300"}
CACHE_DEFAULT = "public, max-age=3600"


def make_client(env=os.environ):
    import boto3

    endpoint = env.get("R2_ENDPOINT") or (
        f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        if env.get("R2_ACCOUNT_ID")
        else None
    )
    missing = [
        k for k in ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET") if not env.get(k)
    ]
    if missing or not endpoint:
        raise RuntimeError(
            "R2 upload needs "
            + ", ".join(missing + ([] if endpoint else ["R2_ACCOUNT_ID or R2_ENDPOINT"]))
        )
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload_files(root: Path, rel_paths: Iterable[str], client=None, env=os.environ) -> list:
    """Upload ``rel_paths`` (relative to ``root``) in the given order; return the keys.

    Callers pass the pointer file (``index.json``) LAST so readers never see a pointer
    to objects that are not uploaded yet.
    """
    client = client or make_client(env)
    bucket, prefix = env["R2_BUCKET"], env.get("R2_PREFIX", "").strip("/")
    keys = []
    for rel in rel_paths:
        p = Path(root) / rel
        key = f"{prefix}/{rel}" if prefix else rel
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=p.read_bytes(),
            ContentType=CONTENT_TYPES.get(p.suffix, "application/octet-stream"),
            CacheControl=CACHE.get(p.name, CACHE_DEFAULT),
        )
        keys.append(key)
    return keys
