"""Upload a published run to an S3-compatible bucket (Cloudflare R2). Credentials from R2_* env only."""

from __future__ import annotations

import json
import logging
import os
import re

from .gfs import run_id_from_iso as gfs_run_id

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


IMMUTABLE = "public, max-age=31536000, immutable"  # run-stamped frames never change
POINTER_TTL = "public, max-age=60"  # latest.json / index.json move every few hours


def _exists(client, bucket: str, key: str, size: int) -> bool:
    try:
        return client.head_object(Bucket=bucket, Key=key).get("ContentLength") == size
    except Exception:  # 404 / not supported: just upload
        return False


def _prune_remote(client, bucket: str, base: str, keep: int, protect: str) -> None:
    """Delete run prefixes under `base` (ends with '/') beyond the newest `keep`."""
    resp = client.list_objects_v2(Bucket=bucket, Prefix=base, Delimiter="/")
    runs = sorted(p["Prefix"][len(base) :].strip("/") for p in resp.get("CommonPrefixes", []))
    runs = [r for r in runs if RUN_RE.match(r)]
    for old in [r for r in runs[:-keep] if r != protect]:
        pg = client.list_objects_v2(Bucket=bucket, Prefix=f"{base}{old}/")
        keys = [{"Key": o["Key"]} for o in pg.get("Contents", [])]
        if keys:
            client.delete_objects(Bucket=bucket, Delete={"Objects": keys})
            log.info("pruned remote run %s%s (%d objects)", base, old, len(keys))


def upload_all(
    client, bucket: str, out_dir: str, res: dict, prefix: str = "", keep: int = 2
) -> int:
    """Upload an `ingest_all` result. Per model: frames (immutable) -> that model's latest.json;
    then the legacy v1 wind tree; weather/index.json LAST (merged with the remote catalogue so a
    partial run, e.g. one model, never drops the others). Returns objects put."""
    pre = (prefix.strip("/") + "/") if prefix.strip("/") else ""
    n = 0
    for mid, lat in res["models"].items():
        for fld in lat["fields"]:
            for fr in fld["frames"]:
                key = pre + fr["png"]
                if _exists(client, bucket, key, fr["bytes"]):
                    continue
                with open(os.path.join(out_dir, fr["png"]), "rb") as fh:
                    client.put_object(
                        Bucket=bucket,
                        Key=key,
                        Body=fh.read(),
                        ContentType="image/png",
                        CacheControl=IMMUTABLE,
                    )
                n += 1
        rel = f"weather/{mid}/latest.json"
        with open(os.path.join(out_dir, rel), "rb") as fh:
            client.put_object(
                Bucket=bucket,
                Key=pre + rel,
                Body=fh.read(),
                ContentType="application/json",
                CacheControl=POINTER_TTL,
            )
        n += 1
        rid = gfs_run_id(lat["run"])
        _prune_remote(client, bucket, f"{pre}weather/{mid}/", keep, rid)
    if res.get("legacy"):
        n += upload_run(client, bucket, out_dir, res["legacy"], prefix, keep)
    # catalogue last, merged with whatever is already published
    with open(os.path.join(out_dir, "weather", "index.json")) as fh:
        idx = json.load(fh)
    try:
        remote = json.loads(
            client.get_object(Bucket=bucket, Key=pre + "weather/index.json")["Body"].read()
        )
        have = {m["id"] for m in idx["models"]}
        idx["models"] += [m for m in remote.get("models", []) if m["id"] not in have]
        order = ["gfs", "ecmwf-ifs", "ecmwf-aifs"]
        idx["models"].sort(key=lambda m: order.index(m["id"]) if m["id"] in order else 99)
    except Exception:
        pass  # no remote catalogue yet
    client.put_object(
        Bucket=bucket,
        Key=pre + "weather/index.json",
        Body=(json.dumps(idx, indent=2, ensure_ascii=False) + "\n").encode(),
        ContentType="application/json",
        CacheControl=POINTER_TTL,
    )
    n += 1
    log.info("uploaded %d objects to bucket %s", n, bucket)
    return n
