"""Upload a published run to an S3-compatible bucket (Cloudflare R2). Credentials from R2_* env only."""

from __future__ import annotations

import logging
import os
import re

log = logging.getLogger("stormtrack.wind")
RUN_RE = re.compile(r"^\d{8}T\d{2}$")


def client_from_env(env=os.environ):
    import boto3  # optional dependency: pip install 'stormtrack-ingest-wind[upload]'

    need = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    miss = [k for k in need if not env.get(k)]
    if miss:
        raise SystemExit(
            f"--upload needs env: {', '.join(miss)} (+ R2_ACCOUNT_ID or R2_ENDPOINT_URL)"
        )
    endpoint = env.get("R2_ENDPOINT_URL") or (
        f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com"
        if env.get("R2_ACCOUNT_ID")
        else None
    )
    if not endpoint:
        raise SystemExit("--upload needs R2_ACCOUNT_ID or R2_ENDPOINT_URL")
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="auto",
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
    )


def upload_run(
    client, bucket: str, out_dir: str, latest: dict, prefix: str = "", keep: int = 2
) -> int:
    """PNGs first (immutable), latest.json LAST, then prune old remote runs. Returns files uploaded."""
    prefix = prefix.strip("/")
    pre = (prefix + "/") if prefix else ""
    n = 0
    for fr in latest["frames"]:
        key = pre + fr["png"]
        with open(os.path.join(out_dir, fr["png"]), "rb") as fh:
            client.put_object(
                Bucket=bucket,
                Key=key,
                Body=fh.read(),
                ContentType="image/png",
                CacheControl="public, max-age=31536000, immutable",
            )
        n += 1
    body = open(os.path.join(out_dir, "wind", "latest.json"), "rb").read()
    client.put_object(
        Bucket=bucket,
        Key=pre + "wind/latest.json",
        Body=body,
        ContentType="application/json",
        CacheControl="public, max-age=60",
    )
    n += 1
    # prune remote runs beyond newest `keep`
    resp = client.list_objects_v2(Bucket=bucket, Prefix=pre + "wind/", Delimiter="/")
    runs = sorted(
        p["Prefix"][len(pre + "wind/") :].strip("/") for p in resp.get("CommonPrefixes", [])
    )
    runs = [r for r in runs if RUN_RE.match(r)]
    for old in runs[:-keep]:
        pg = client.list_objects_v2(Bucket=bucket, Prefix=f"{pre}wind/{old}/")
        keys = [{"Key": o["Key"]} for o in pg.get("Contents", [])]
        if keys:
            client.delete_objects(Bucket=bucket, Delete={"Objects": keys})
            log.info("pruned remote run %s (%d objects)", old, len(keys))
    log.info("uploaded %d objects to bucket %s", n, bucket)
    return n
