"""Incremental merge -> prune -> thin -> publish (CONTRACTS section 6)."""

from __future__ import annotations

import json
import time
import urllib.request
import zlib
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .io import atomic_write_bytes, dumps
from .schema import COLS, validate_all
from .sources import Batch, default_sources

REL = (
    "lightning/flashes.json",
    "lightning/coverage.geojson",
    "lightning/recent.json",
    "lightning/index.json",
)
RECENT_COLS = ["id", "t_ms", "lon", "lat", "energy_fj", "src"]


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> float:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()


def keep_hash(t, lon, lat):
    """Deterministic pseudo-random u in [0,1) from the PUBLISHED (rounded) values of a flash, so
    the same flash gets the same u when it is re-read from the previous flashes.json."""
    tc = np.round(np.asarray(t) * 100).astype(np.uint64)
    lo = np.round((np.asarray(lon) + 180) * 100).astype(np.uint64)
    la = np.round((np.asarray(lat) + 90) * 100).astype(np.uint64)
    h = (tc * np.uint64(2654435761) + lo * np.uint64(40503) + la * np.uint64(9973)) & np.uint64(
        0xFFFFFFFF
    )
    h = (h ^ (h >> np.uint64(15))) * np.uint64(2246822519) & np.uint64(0xFFFFFFFF)
    h = (h ^ (h >> np.uint64(13))) & np.uint64(0xFFFFFFFF)
    return h.astype("f8") / 2**32


def _read(path_or_url: str) -> bytes:
    if path_or_url.startswith(("http://", "https://")):
        req = urllib.request.Request(path_or_url, headers={"User-Agent": "stormtrack-web-ingest"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    return Path(path_or_url).read_bytes()


def load_prev(out_dir: Path, prev_url: str | None):
    """Return (index, flashes, flashes_raw_bytes) from the output dir or ``prev_url`` or None."""
    bases = [str(Path(out_dir) / "lightning")]
    if prev_url:
        bases.append(prev_url.rstrip("/") + "/lightning")
    for base in bases:
        try:
            idx = json.loads(_read(f"{base}/index.json"))
            raw = _read(f"{base}/flashes.json")
            fl = json.loads(raw)
            if idx.get("schema") == 1 and fl.get("schema") == 1 and fl.get("cols") == COLS:
                return idx, fl, raw
        except Exception:  # noqa: BLE001 - absent/corrupt previous output = cold start
            continue
    return None


def rows_to_arrays(fl: dict):
    """-> (t, lon, lat, energy (NaN for null), src) float arrays."""
    rows = fl["rows"]
    t0 = parse_iso(fl["t0"])
    a = np.array(
        [[r[0], r[1], r[2], np.nan if r[3] is None else r[3], r[4]] for r in rows], dtype="f8"
    ).reshape(-1, 5)
    return t0 + a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4].astype(int)


def build_flashes(t, lon, lat, en, src, decimals) -> dict:
    """``decimals[i]``: lon/lat decimals of source i. NaN energy is written as null."""
    t0 = int(t.min() // 60 * 60) if len(t) else 0
    rows = [
        [
            round(a - t0, 2),
            round(b, decimals[k]),
            round(c, decimals[k]),
            None if d != d else round(d, 2),
            k,
        ]
        for a, b, c, d, k in zip(t.tolist(), lon.tolist(), lat.tolist(), en.tolist(), src.tolist())
    ]
    return {"schema": 1, "t0": iso(t0), "cols": COLS, "rows": rows}


def merge(prev, new: tuple, now: float, window_s: float, max_rows, keep_fraction: float, dp: int):
    """Combine one source's previous + new arrays (t, lon, lat, en); prune the window; drop
    duplicates; thin deterministically unless ``max_rows`` is None (low-volume source).

    Returns (t, lon, lat, en, keep_fraction_used, decimated).
    """
    parts = [new] if prev is None else [prev, new]
    t = np.concatenate([p[0] for p in parts])
    lon = np.round(np.concatenate([p[1] for p in parts]), dp)
    lat = np.round(np.concatenate([p[2] for p in parts]), dp)
    en = np.concatenate([p[3] for p in parts])
    t = np.round(t, 2)  # same precision as published, so reloaded rows compare equal
    ok = (t >= now - window_s) & (t <= now + 120)
    t, lon, lat, en = t[ok], lon[ok], lat[ok], en[ok]
    # exact duplicates (same file ingested twice, or identical rows)
    if len(t):
        _, first = np.unique(np.stack([t, lon, lat]), axis=1, return_index=True)
        first.sort()
        t, lon, lat, en = t[first], lon[first], lat[first], en[first]
    if max_rows is None:
        order = np.argsort(t, kind="stable")
        return t[order], lon[order], lat[order], en[order], 1.0, False
    u = keep_hash(t, lon, lat) if len(t) else np.empty(0)
    frac = keep_fraction
    keep = u < frac
    # hard cap: lower the fraction until the count fits (never exceeds max_rows)
    if keep.sum() > max_rows:
        if max_rows <= 0:
            keep[:] = False
            frac = 0.0
        else:
            frac = float(np.sort(u[keep])[max_rows - 1]) * 0.9999
            keep = u < frac
    order = np.argsort(t[keep], kind="stable")
    sel = np.flatnonzero(keep)[order]
    return t[sel], lon[sel], lat[sel], en[sel], frac, bool(len(t) and frac < 1.0)


def strike_id(src: int, t_ms: int, lon: float, lat: float) -> str:
    """Stable 8-hex id of (src, t, lon, lat) as PUBLISHED (so it survives re-reading the files)."""
    return f"{zlib.crc32(f'{src}|{t_ms}|{lon:.4f}|{lat:.4f}'.encode()):08x}"


def build_recent(flashes: dict, now: float, window_s: float, cap: int, thin_src: set) -> dict:
    """Rolling file for the live client: strikes of the last ``window_s`` seconds (CONTRACTS 6.2).

    Only sources in ``thin_src`` (high-volume) are thinned, by the same stable hash as flashes."""
    t0 = parse_iso(flashes["t0"])
    rows = [r for r in flashes["rows"] if now - window_s <= t0 + r[0] <= now + 120]
    if len(rows) > cap:
        thin = [r for r in rows if r[4] in thin_src]
        other = len(rows) - len(thin)
        room = max(cap - other, 0)
        if len(thin) > room:
            u = keep_hash([t0 + r[0] for r in thin], [r[1] for r in thin], [r[2] for r in thin])
            kept = set(np.argsort(u, kind="stable")[:room].tolist())
            drop = {id(r) for i, r in enumerate(thin) if i not in kept}
            rows = [r for r in rows if id(r) not in drop]
    out = []
    for r in rows:
        t_ms = int(round((t0 + r[0]) * 1000))
        out.append([strike_id(r[4], t_ms, r[1], r[2]), t_ms, r[1], r[2], r[3], r[4]])
    return {
        "schema": 1,
        "generated": iso(now),
        "window_s": int(window_s),
        "cols": RECENT_COLS,
        "rows": out,
    }


def _empty_batch(src, prev_state, err):
    return Batch(*(np.empty(0),) * 4, state=prev_state.get(src.id, {}), errors=[err], failed=True)


def run(
    out_dir,
    prev_url: str | None = None,
    window_min: int = 60,
    max_rows: int = 100_000,
    sources=None,
    now: float | None = None,
    log=print,
    poll_s: float = 20,
    recent_window_s: float = 180,
    recent_cap: int = 4000,
) -> dict:
    """Run one ingest. Returns a result dict; ``result['ok']`` is False if nothing was produced."""
    out_dir = Path(out_dir)
    now = time.time() if now is None else now
    window_s = window_min * 60
    sources = sources or default_sources()
    prev = load_prev(out_dir, prev_url)
    prev_idx, prev_fl, prev_raw = prev if prev else (None, None, None)
    prev_state = (prev_idx or {}).get("state", {})
    prev_ids = [s["id"] for s in prev_idx["sources"]] if prev else []
    prev_arr = rows_to_arrays(prev_fl) if prev else None

    def prev_rows_of(src):
        """This source's previously published (t, lon, lat, en), or None."""
        if prev_arr is None or src.id not in prev_ids:
            return None
        m = prev_arr[4] == prev_ids.index(src.id)
        return tuple(a[m] for a in prev_arr[:4])

    batches: list[tuple] = []
    for src in sources:
        pr = prev_rows_of(src)
        try:
            b = src.poll(prev_state.get(src.id), now, window_s, pr[:3] if pr else None)
        except Exception as e:  # noqa: BLE001 - one broken source must not take down the others
            b = _empty_batch(src, prev_state, f"{src.id}: {e}")
        batches.append((src, b))

    errors = [e for _, b in batches for e in b.errors]
    n_files = sum(b.files for _, b in batches)
    n_bytes = sum(b.bytes for _, b in batches)
    result = {"ok": False, "files": n_files, "bytes": n_bytes, "errors": errors, "stale": True}

    prev_src = {s["id"]: s for s in prev_idx["sources"]} if prev else {}
    newest, fresh = {}, {}
    for src, b in batches:
        ne = b.newest_end
        if ne is None and src.id in prev_src and prev_src[src.id].get("updated"):
            ne = parse_iso(prev_src[src.id]["updated"])
        newest[src.id] = ne
        fresh[src.id] = bool(not b.failed and b.newest_end is not None and now - ne <= src.stale_s)
    n_new = sum(len(b.t) for _, b in batches)
    if prev is None and n_new == 0 and not any(fresh.values()):
        log("sources unreachable/stale and no previous output: nothing to publish")
        return result

    # coverage first: a source we cannot describe cannot be published (no rows to lose on a cold start)
    covs, active = {}, []
    for src, b in batches:
        st = b.state
        try:
            if src.kind == "satellite" and not st.get("sub_lon"):
                raise ValueError("no sub-satellite longitude yet")
            covs[src.id] = src.coverage(st)
            active.append((src, b))
        except Exception as e:  # noqa: BLE001
            errors.append(f"{src.id}: no coverage information, source skipped ({e})")
            log(f"no coverage information for {src.id}")
    if not active:
        return result
    ids = [s.id for s, _ in active]
    index_of = {sid: i for i, sid in enumerate(ids)}
    decimals = [s.decimals for s, _ in active]
    all_stale = not any(fresh[i] for i in ids)

    unexpired = prev is not None and (
        not len(prev_arr[0]) or float(prev_arr[0].min()) >= now - window_s
    )
    if (
        all_stale and n_new == 0 and unexpired and prev_ids == ids
    ):  # everything stale and nothing new: republish the previous flashes untouched
        flashes, flashes_raw = prev_fl, prev_raw
        kfs = {i: prev_state.get(i, {}).get("keep_fraction", 1.0) for i in ids}
        dec = {i: bool(prev_state.get(i, {}).get("decimated")) for i in ids}
    else:
        low = 0
        per = {}
        for src, b in active:
            pr = prev_rows_of(src)
            if src.high_volume:
                continue
            per[src.id] = merge(
                pr, (b.t, b.lon, b.lat, b.energy_fj), now, window_s, None, 1.0, src.decimals
            )
            low += len(per[src.id][0])
        hv = [(s, b) for s, b in active if s.high_volume]
        budget = max(max_rows - low, 0) // max(len(hv), 1)
        kfs, dec = {}, {}
        for src, b in hv:
            kf = float(prev_state.get(src.id, {}).get("keep_fraction", 1.0)) if prev else 1.0
            if fresh[src.id] and b.files and len(b.t) > 100:
                # adapt the thinning fraction to the observed flash rate (never just ratchets down)
                rate = len(b.t) / max(b.t.max() - b.t.min(), 20.0)
                target = float(min(1.0, 0.9 * budget / max(rate * max(window_s, 1.0), 1.0)))
                # smooth: a short incremental batch must not whipsaw the sampling of older rows
                kf = target if not prev else 0.7 * kf + 0.3 * target
            per[src.id] = merge(
                prev_rows_of(src),
                (b.t, b.lon, b.lat, b.energy_fj),
                now,
                window_s,
                budget,
                kf,
                src.decimals,
            )
        for sid, r in per.items():
            kfs[sid], dec[sid] = r[4], r[5]
        order = [per[i] for i in ids]
        t = np.concatenate([r[0] for r in order])
        lon = np.concatenate([r[1] for r in order])
        lat = np.concatenate([r[2] for r in order])
        en = np.concatenate([r[3] for r in order])
        sidx = np.concatenate([np.full(len(r[0]), k, int) for k, r in enumerate(order)])
        o = np.argsort(t, kind="stable")
        flashes = build_flashes(t[o], lon[o], lat[o], en[o], sidx[o], decimals)
        flashes_raw = dumps(flashes)

    counts = [0] * len(ids)
    for r in flashes["rows"]:
        counts[r[4]] += 1
    updated_ts = [newest[i] for i in ids if newest[i] is not None]
    # --- index.sources ---------------------------------------------------------------------
    srcs_out, states, feats = [], {}, []
    for src, b in active:
        sid = src.id
        stale = not fresh[sid]
        lat_s = b.latency_s or (prev_src.get(sid, {}).get("latency_s")) or src.default_latency_s
        entry = {
            "id": sid,
            "name": src.name,
            "licence": src.licence,
            "attribution": src.attribution,
            "kind": src.kind,
            "time_precision": src.time_precision,
            "time_uncertainty_s": src.time_uncertainty_s,
            "unofficial": src.unofficial,
            "latency_s": int(round(lat_s)),
            "stale": stale,
            "updated": iso(newest[sid]) if newest[sid] is not None else None,
            "coverage": "lightning/coverage.geojson",
            "lon_lat_dp": src.decimals,
            "count": counts[index_of[sid]],
        }
        if src.kind == "satellite":
            entry["satellites"] = b.satellites or prev_src.get(sid, {}).get("satellites", [])
        srcs_out.append(entry)
        states[sid] = {
            **b.state,
            "keep_fraction": kfs.get(sid, 1.0),
            "decimated": dec.get(sid, False),
        }
        for f in covs[sid]["features"]:
            f["properties"] = {**f.get("properties", {}), "source": sid}
            f["properties"].setdefault("basis", src.coverage_basis)
            feats.append(f)
    cov = {"type": "FeatureCollection", "features": feats}

    # --- notes -----------------------------------------------------------------------------
    notes = "Coverage: " + "; ".join(f"{s.name}: {s.coverage_note}" for s, _ in active) + "."
    if not any(s.covers_south_asia for s, _ in active):
        notes += " No open real-time lightning feed covers South Asia."
    notes += " Coverage footprints are approximate (see coverage.geojson)."
    for s, _ in active:
        if s.unofficial:
            notes += (
                f" {s.name} is an unofficial, undocumented feed with no published licence: "
                f"strike times are {s.time_uncertainty_s:g} s-uncertain age-bucket midpoints and no energy is reported."
            )
    for s, _ in active:
        if s.high_volume and dec.get(s.id):
            notes += (
                f" Showing a uniform pseudo-random {kfs[s.id] * 100:.0f}% sample of detected "
                f"{s.id} flashes (capped at {max_rows} rows)."
            )
    for s, b in active:
        if not fresh[s.id]:
            notes += f" Data is stale for {s.id}: no new data in the last {int(s.stale_s // 60)} minutes."
        for sat, why in b.unused.items():
            notes += f" {sat} not used ({why})."
    # end-to-end delay a client should play behind real time: slowest source latency + the 20 s
    # GLM file span + our publishing interval
    delay_s = max(30, int(round(max(e["latency_s"] for e in srcs_out) + 20 + poll_s)))
    recent = build_recent(
        flashes,
        now,
        recent_window_s,
        recent_cap,
        {k for k, (s_, _) in enumerate(active) if s_.high_volume},
    )
    index = {
        "schema": 1,
        "generated": iso(now),
        "updated": iso(max(updated_ts)) if updated_ts else iso(now),
        "window_minutes": window_min,
        "count": len(flashes["rows"]),
        "stale": all_stale,
        "sources": srcs_out,
        "live": {"delay_s": delay_s, "poll_s": int(poll_s)},
        "notes": notes,
        "state": states,
    }
    problems = validate_all(index, flashes, cov)
    if problems:
        log("refusing to publish, schema problems: " + "; ".join(problems[:5]))
        errors.append("schema problems: " + "; ".join(problems[:5]))
        return result
    # all data files first, atomically; the pointer last
    atomic_write_bytes(out_dir / REL[0], flashes_raw)
    atomic_write_bytes(out_dir / REL[1], dumps(cov))
    atomic_write_bytes(out_dir / REL[2], dumps(recent))
    atomic_write_bytes(out_dir / REL[3], dumps(index))
    result.update(ok=True, stale=index["stale"], index=index, count=index["count"], rel=list(REL))
    result["raw_flashes"] = sum(b.raw_flashes for _, b in batches)
    result["recent"] = len(recent["rows"])
    result["counts"] = {sid: counts[index_of[sid]] for sid in ids}
    return result
