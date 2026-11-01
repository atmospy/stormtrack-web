"""IO helpers: atomic writes, HTTP with retries, time formatting."""

from __future__ import annotations

import gzip
import json
import os
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

UA = {
    "User-Agent": "stormtrack-web-ingest (https://github.com/atmospy/stormtrack-web)",
    "Accept-Encoding": "gzip",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ms_iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_get(url: str, timeout: float = 90.0, retries: int = 2, backoff: float = 3.0) -> bytes:
    """GET with gzip support and a few retries. Never logs the URL (it may carry a key)."""
    last: Optional[Exception] = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except Exception as exc:  # noqa: BLE001
            last = exc
            if i < retries:
                time.sleep(backoff * (i + 1))
    raise RuntimeError(f"{type(last).__name__}: {last}".replace(url, "<url>")) from None


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def write_json(path: Path, obj) -> int:
    data = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode()
    atomic_write_bytes(path, data)
    return len(data)


def gz_size(path: Path) -> int:
    return len(gzip.compress(Path(path).read_bytes(), compresslevel=6))
