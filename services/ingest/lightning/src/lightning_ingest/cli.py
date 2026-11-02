from __future__ import annotations

import argparse
import os
import signal
import sys
import threading
import time
from pathlib import Path

from . import pipeline
from .sources import SOURCE_IDS, default_sources


def main(argv=None, *, clock=time.monotonic, sleep=None, stop=None) -> int:
    ap = argparse.ArgumentParser(prog="ingest-lightning", description=__doc__)
    ap.add_argument("--out", default="public-data", help="output root (writes <out>/lightning/*)")
    ap.add_argument(
        "--prev-url",
        help="base URL of the previously published data (stateless CI), e.g. https://data.example.com",
    )
    ap.add_argument("--window-minutes", type=int, default=60)
    ap.add_argument("--max-rows", type=int, default=100_000)
    ap.add_argument(
        "--source",
        action="append",
        help="source id, repeatable or comma list (default: goes-glm; env LIGHTNING_SOURCES). "
        f"Available: {', '.join(SOURCE_IDS)}. iitm-damini and imd-lightning are UNOFFICIAL feeds (opt-in only)",
    )
    ap.add_argument(
        "--iitm-min-interval-s",
        type=float,
        default=60,
        help="minimum seconds between requests to the IITM feed (a sooner poll makes no request; "
        "never below 60)",
    )
    ap.add_argument(
        "--imd-min-interval-s",
        type=float,
        default=60,
        help="minimum seconds between requests to the IMD service (a sooner poll makes no request; "
        "never below 60)",
    )
    ap.add_argument(
        "--loop",
        type=float,
        nargs="?",
        const=20.0,
        default=None,
        metavar="SECONDS",
        help="run repeatedly every SECONDS (default 20 when given without a value) until "
        "Ctrl-C/SIGTERM; without it, run once (CI)",
    )
    ap.add_argument("--recent-window-s", type=float, default=180, help="recent.json window")
    ap.add_argument(
        "--upload-full-every-s",
        type=float,
        default=300,
        help="loop + --upload: re-upload flashes.json/coverage this often (recent.json and "
        "index.json are uploaded every cycle)",
    )
    ap.add_argument(
        "--satellites",
        default="G16,G18,G19",
        help="candidates; those delivering a file in the last 30 min are detected and used",
    )
    ap.add_argument("--keep-degraded", action="store_true", help="keep flash_quality_flag != 0")
    ap.add_argument("--upload", action="store_true", help="upload to Cloudflare R2 (R2_* env vars)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)

    log = print if a.verbose else (lambda *_: None)
    raw = a.source or [os.environ.get("LIGHTNING_SOURCES") or "goes-glm"]
    names = []
    for chunk in raw:
        names += [n.strip() for n in chunk.split(",") if n.strip()]
    names = list(dict.fromkeys(names))
    try:
        sources = default_sources(
            names,
            glm={
                "satellites": [s.strip() for s in a.satellites.split(",") if s.strip()],
                "keep_degraded": a.keep_degraded,
            },
            iitm={"min_interval_s": a.iitm_min_interval_s},
            imd={"min_interval_s": a.imd_min_interval_s},
        )
    except ValueError as e:
        ap.error(str(e))
    out = Path(a.out)
    loop_s = a.loop
    state = {"last_full": None}

    def cycle() -> bool:
        res = pipeline.run(
            out,
            a.prev_url,
            a.window_minutes,
            a.max_rows,
            sources=sources,
            log=log,
            poll_s=loop_s or 20,
            recent_window_s=a.recent_window_s,
        )
        for e in res["errors"]:
            print("warning:", e, file=sys.stderr)
        if not res["ok"]:
            print("error: nothing could be produced", file=sys.stderr)
            return False
        idx = res["index"]
        per = ", ".join(
            f"{x['id']} {x['count']}" + (" (stale)" if x["stale"] else "") for x in idx["sources"]
        )
        print(
            f"lightning: {idx['count']} strikes [{per}], recent {res['recent']}, "
            f"{res['files']} new files ({res['bytes'] / 1e6:.1f} MB), stale={idx['stale']}"
        )
        if a.verbose:
            print(idx["notes"])
        if a.upload:
            from .upload import upload_files

            rel = res["rel"]
            now = clock()
            full = (
                loop_s is None
                or state["last_full"] is None
                or now - state["last_full"] >= a.upload_full_every_s
            )
            if full:
                state["last_full"] = now
            else:  # fast path: only the small rolling file and the pointer (index last)
                rel = [r for r in rel if r.endswith(("recent.json", "index.json"))]
            keys = upload_files(out, rel)
            print("uploaded:", ", ".join(keys))
        return True

    if loop_s is None:
        return 0 if cycle() else 1
    stop = stop or threading.Event()
    old = {}
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            old[sig] = signal.signal(sig, lambda *_: stop.set())
        except ValueError:  # not in the main thread (tests)
            pass
    try:
        run_loop(cycle, loop_s, stop, clock=clock, sleep=sleep)
    finally:
        for sig, h in old.items():
            signal.signal(sig, h)
    print("stopped")
    return 0


def run_loop(cycle, interval, stop, clock=time.monotonic, sleep=None, max_cycles=None) -> int:
    """Call ``cycle()`` every ``interval`` s (start-to-start) until ``stop`` is set.

    A cycle that returns False or raises backs off exponentially (interval * 2**n, max 300 s);
    the loop never exits on an error. ``sleep`` and ``clock`` are injectable for tests."""
    sleep = sleep or stop.wait
    fails = cycles = 0
    while not stop.is_set():
        t0 = clock()
        try:
            ok = cycle()
        except Exception as e:  # noqa: BLE001
            print("error:", repr(e), file=sys.stderr)
            ok = False
        cycles += 1
        fails = 0 if ok else fails + 1
        if max_cycles is not None and cycles >= max_cycles:
            break
        if stop.is_set():
            break
        wait = max(interval - (clock() - t0), 0.0)
        if fails:
            wait = max(wait, min(interval * 2**fails, 300.0))
        sleep(wait)
    return cycles


if __name__ == "__main__":
    sys.exit(main())
