"""recent.json (CONTRACTS 6.2) and the --loop mode. Offline, no real waiting."""

from __future__ import annotations

import json
import threading

from conftest import NOW, populate
from iitm_fixtures import FakeFetcher, page
from lightning_ingest import cli, pipeline
from lightning_ingest.schema import validate_all, validate_recent
from lightning_ingest.sources.goes_glm import GoesGlm
from lightning_ingest.sources.iitm_damini import IitmDamini


def read(out, name):
    return json.loads((out / "lightning" / name).read_text())


def both(s3, fetcher):
    populate(s3, NOW, minutes=5, sats=(("G19", -75.2),))
    return [
        GoesGlm(http=s3, workers=2, satellites=["G19"]),
        IitmDamini(fetcher=fetcher, sleep=lambda s: None),
    ]


def run(out, srcs, now, **kw):
    return pipeline.run(out, sources=srcs, now=now, log=lambda *_: None, **kw)


def test_recent_window_cols_null_energy_and_live(s3, tmp_path):
    f = FakeFetcher(page([(20.0, 80.0, "5min"), (21.0, 81.0, "15min")]))
    srcs = both(s3, f)
    run(
        tmp_path, srcs, NOW
    )  # cold start: IITM strikes sit at bucket midpoints (outside the 180 s window)
    glm0 = [r for r in read(tmp_path, "recent.json")["rows"] if r[5] == 0]
    assert glm0 and all(r[4] is not None for r in glm0)
    f.body = page([(20.0, 80.0, "10min"), (22.0, 82.0, "5min")])
    run(tmp_path, srcs, NOW + 70)  # the new strike is spread between the two polls
    rec = read(tmp_path, "recent.json")
    assert validate_recent(rec) == [] and rec["window_s"] == 180
    assert rec["cols"] == ["id", "t_ms", "lon", "lat", "energy_fj", "src"]
    for r in rec["rows"]:
        assert (NOW + 70) * 1000 - 180_000 <= r[1] <= (NOW + 70) * 1000 + 120_000
        assert len(r[0]) == 8
    iitm = [r for r in rec["rows"] if r[5] == 1]
    assert [r[2:5] for r in iitm] == [[82.0, 22.0, None]]  # old/duplicate strikes are out
    assert "NaN" not in (tmp_path / "lightning" / "recent.json").read_text()
    idx = read(tmp_path, "index.json")
    assert idx["live"]["poll_s"] == 20 and idx["live"]["delay_s"] >= 30
    assert (
        validate_all(idx, read(tmp_path, "flashes.json"), read(tmp_path, "coverage.geojson")) == []
    )
    # recent.json is written before index.json (index is the pointer)
    assert pipeline.REL[-1] == "lightning/index.json" and "lightning/recent.json" in pipeline.REL


def test_recent_ids_stable_across_runs(s3, tmp_path):
    f = FakeFetcher(page([(20.0, 80.0, "5min")]))
    srcs = both(s3, f)
    run(tmp_path, srcs, NOW)
    a = {r[0]: r for r in read(tmp_path, "recent.json")["rows"]}
    run(tmp_path, srcs, NOW + 10)  # reloads flashes.json from disk
    b = {r[0]: r for r in read(tmp_path, "recent.json")["rows"]}
    shared = set(a) & set(b)
    assert shared and all(a[i] == b[i] for i in shared)
    assert len(a) == len(set(a))


def test_recent_window_prunes(s3, tmp_path):
    srcs = both(s3, FakeFetcher(page([(20.0, 80.0, "5min")])))
    run(tmp_path, srcs, NOW)
    run(tmp_path, srcs, NOW + 400)  # everything is old; stale sources, nothing new
    assert read(tmp_path, "recent.json")["rows"] == []


def test_recent_cap_thins_only_glm(s3, tmp_path):
    items = [(10 + i * 0.01, 80.0 + (i % 5) * 0.01, "5min") for i in range(300)]
    srcs = both(s3, FakeFetcher(page(items)))
    run(tmp_path, srcs, NOW, recent_cap=200, recent_window_s=3600)
    rec = read(tmp_path, "recent.json")
    n_iitm = sum(1 for r in rec["rows"] if r[5] == 1)
    assert n_iitm == 300  # never thinned (so the file may exceed the cap)
    assert sum(1 for r in rec["rows"] if r[5] == 0) == 0  # GLM took the whole cut
    full = read(tmp_path, "flashes.json")
    assert sum(1 for r in full["rows"] if r[4] == 0) > 0
    run(tmp_path, srcs, NOW + 1, recent_cap=40, recent_window_s=3600)
    ids1 = {r[0] for r in read(tmp_path, "recent.json")["rows"] if r[5] == 0}
    run(tmp_path, srcs, NOW + 2, recent_cap=40, recent_window_s=3600)
    ids2 = {r[0] for r in read(tmp_path, "recent.json")["rows"] if r[5] == 0}
    assert ids1 == ids2  # stable thinning


# ---- loop ---------------------------------------------------------------------------------
class Clock:
    def __init__(self):
        self.t = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


def test_run_loop_interval_backoff_and_stop():
    clk, stop = Clock(), threading.Event()
    results = iter([True, False, False, True, True])

    def cycle():
        clk.t += 3  # the cycle itself takes 3 s
        ok = next(results)
        if not ok or True:
            pass
        return ok

    def sleep(s):
        clk.sleep(s)
        if len(clk.sleeps) == 5:
            stop.set()  # "Ctrl-C" arrives during the last sleep

    n = cli.run_loop(cycle, 20, stop, clock=clk, sleep=sleep)
    assert n == 5
    assert clk.sleeps[0] == 17  # start-to-start 20 s
    assert clk.sleeps[1] == 40 and clk.sleeps[2] == 80  # error backoff 20*2^n
    assert clk.sleeps[3] == 17  # recovered


def test_run_loop_survives_exceptions_and_caps_backoff():
    clk, stop = Clock(), threading.Event()

    def cycle():
        raise RuntimeError("boom")

    def sleep(s):
        clk.sleep(s)
        if len(clk.sleeps) == 8:
            stop.set()

    cli.run_loop(cycle, 20, stop, clock=clk, sleep=sleep)
    assert max(clk.sleeps) == 300


def test_main_loop_uploads_and_single_run(monkeypatch, tmp_path):
    uploads, runs = [], []

    def fake_run(out, prev_url, window, max_rows, sources, log, **kw):
        runs.append(kw)
        idx = {"count": 0, "stale": False, "notes": "", "sources": []}
        return {
            "ok": True, "errors": [], "index": idx, "files": 0, "bytes": 0, "recent": 0,
            "rel": list(pipeline.REL),
        }  # fmt: skip

    import lightning_ingest.upload as up

    monkeypatch.setattr(cli.pipeline, "run", fake_run)
    monkeypatch.setattr(up, "upload_files", lambda root, rel: uploads.append(list(rel)) or rel)
    clk, stop = Clock(), threading.Event()

    def sleep(s):
        clk.sleep(s)
        if len(clk.sleeps) == 20:  # 20 cycles x 20 s = 400 s
            stop.set()

    rc = cli.main(["--out", str(tmp_path), "--loop", "--upload"], clock=clk, sleep=sleep, stop=stop)
    assert rc == 0 and len(runs) == 20 and runs[0]["poll_s"] == 20
    full = [u for u in uploads if len(u) == 4]
    fast = [u for u in uploads if len(u) == 2]
    assert len(full) == 2 and len(fast) == 18  # first cycle and every >= 300 s
    assert fast[0] == ["lightning/recent.json", "lightning/index.json"]
    assert full[0][-1] == "lightning/index.json"
    # single run: one cycle, all files, exit code
    uploads.clear()
    assert cli.main(["--out", str(tmp_path), "--upload"]) == 0
    assert len(runs) == 21 and len(uploads) == 1 and len(uploads[0]) == 4
