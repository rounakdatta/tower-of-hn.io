#!/usr/bin/env python3
"""Measure the Hacker News firehose for a fixed window.

Records every new item (via /v0/maxitem), front-page rank snapshots and
/v0/updates sizes, so the plan's cost and latency numbers rest on data.

usage: probe.py <out_dir> <minutes>
"""
import json, os, sys, time, threading, urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://hacker-news.firebaseio.com/v0"
UA = {"User-Agent": "towerofhn-firehose-probe/0.1"}


def get(path, timeout=10):
    req = urllib.request.Request(f"{API}/{path}.json", headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return json.loads(body), len(body)


def main(out_dir, minutes):
    os.makedirs(out_dir, exist_ok=True)
    items_f = open(os.path.join(out_dir, "items.jsonl"), "a")
    ranks_f = open(os.path.join(out_dir, "ranks.jsonl"), "a")
    upd_f = open(os.path.join(out_dir, "updates.jsonl"), "a")
    lock = threading.Lock()
    pool = ThreadPoolExecutor(8)
    end = time.time() + minutes * 60
    last, _ = get("maxitem")
    next_ranks = next_upd = 0.0

    def fetch(i):
        t0 = time.time()
        for attempt in range(5):
            try:
                it, size = get(f"item/{i}")
            except Exception as e:  # noqa: BLE001
                it, size = None, 0
            if it is not None:
                break
            time.sleep(1 + attempt)  # item id allocated before the body lands
        rec = {"id": i, "fetched": time.time(), "fetch_ms": int((time.time() - t0) * 1000), "bytes": size}
        if it:
            rec.update({k: it.get(k) for k in ("type", "by", "time", "parent", "dead", "deleted")})
            rec["chars"] = len(it.get("text") or "")
            rec["title"] = it.get("title")
        with lock:
            items_f.write(json.dumps(rec) + "\n")
            items_f.flush()

    while time.time() < end:
        now = time.time()
        try:
            mx, _ = get("maxitem")
            for i in range(last + 1, mx + 1):
                pool.submit(fetch, i)
            last = max(last, mx)
        except Exception as e:  # noqa: BLE001
            print("maxitem error", e, file=sys.stderr)
        if now >= next_ranks:
            try:
                top, size = get("topstories")
                ranks_f.write(json.dumps({"t": now, "top": top[:60], "bytes": size}) + "\n")
                ranks_f.flush()
            except Exception as e:  # noqa: BLE001
                print("topstories error", e, file=sys.stderr)
            next_ranks = now + 30
        if now >= next_upd:
            try:
                u, size = get("updates")
                upd_f.write(json.dumps({"t": now, "items": len(u.get("items", [])), "profiles": len(u.get("profiles", [])), "bytes": size, "ids": u.get("items", [])}) + "\n")
                upd_f.flush()
            except Exception as e:  # noqa: BLE001
                print("updates error", e, file=sys.stderr)
            next_upd = now + 10
        time.sleep(max(0, 2 - (time.time() - now)))
    pool.shutdown(wait=True)
    print("done", last)


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]))
