#!/usr/bin/env python3
"""Capacity test results (tohn-scale-staging's out/): listeners vs throughput and latency, towerd's CPU and memory, the
nodes' load, and production's health, minute by minute; then the most listeners held with p99 under each bound.

usage: capacity.py OUT_DIR"""
import json, sys, os, collections, statistics as st

d = sys.argv[1]
rows = collections.defaultdict(lambda: {'listeners': 0, 'rps': 0, 'errors': 0, 'mbit': 0.0, 'by': collections.defaultdict(list)})
for tag in ('a', 'b'):
    p = os.path.join(d, f'load-{tag}.jsonl')
    if not os.path.exists(p):
        continue
    for line in open(p):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('done'):
            continue
        k = r['t'] // 10 * 10
        row = rows[k]
        row['listeners'] += r['listeners']; row['rps'] += r['rps']; row['errors'] += r['errors']; row['mbit'] += r['mbit']
        for kind, s in r['by'].items():
            row['by'][kind].append(s)
mon = [json.loads(l) for l in open(os.path.join(d, 'monitor.jsonl'))] if os.path.exists(os.path.join(d, 'monitor.jsonl')) else []
top = [json.loads(l) for l in open(os.path.join(d, 'staging-top.jsonl'))] if os.path.exists(os.path.join(d, 'staging-top.jsonl')) else []
t0 = mon[0]['t'] if mon else 0

def worst(ss, q):
    xs = [s.get(q) for s in ss if s.get(q) is not None]
    return max(xs) if xs else None

def cpu_m(v):
    return float(v[:-1]) if v.endswith('m') else float(v) * 1000

print(f"{'t':>5} {'listen':>6} {'req/s':>6} {'err':>4} {'Mbit':>5} | {'head p50/p99':>13} {'clip p50/p99':>13} {'side p99':>8} {'want p99':>8} | {'towerd cpu':>10} {'mem':>6} | viz l1 jom l1 kan l1 prod")
summary = []
for k in sorted(rows):
    r = rows[k]
    def pp(kind, q):
        v = worst(r['by'].get(kind, []), q)
        return '-' if v is None else f'{v:.0f}'
    near = [x for x in top if x['c'] == 'web' and abs(x['t'] - (t0 + k)) < 15] if t0 else []
    cpu = cpu_m(near[-1]['cpu']) if near else None
    mem = near[-1]['mem'] if near else '-'
    m = min(mon, key=lambda x: abs(x['t'] - (t0 + k))) if mon else {}
    loads = ' '.join(f"{(m.get(n) or {}).get('l1', '-')!s:>6}" for n in ('vizerizz', 'jomjom', 'kanmani'))
    print(f"{k:5} {r['listeners']:6} {r['rps']:6} {r['errors']:4} {r['mbit']:5.1f} | {pp('head','p50'):>5}/{pp('head','p99'):>6} ms {pp('clip','p50'):>5}/{pp('clip','p99'):>6} ms {pp('sidecar','p99'):>8} {pp('want','p99'):>8} | {('-' if cpu is None else f'{cpu:.0f}m'):>10} {mem:>6} | {loads} {m.get('prod', '-')}")
    summary.append({'t': k, 'listeners': r['listeners'], 'rps': r['rps'], 'errors': r['errors'], 'mbit': r['mbit'],
                    'p99': max([worst(r['by'].get(x, []), 'p99') or 0 for x in ('head', 'clip', 'sidecar', 'delta', 'floor')]), 'cpu_m': cpu})
for bound in (50, 100, 250, 500):
    ok = [s for s in summary if s['p99'] <= bound and s['errors'] == 0]
    best = max(ok, key=lambda s: s['listeners']) if ok else None
    print(f"most listeners with every kind's p99 <= {bound} ms and no errors: {best['listeners'] if best else 0}" + (f" ({best['rps']} req/s, {best['mbit']:.0f} Mbit/s, towerd {best['cpu_m']:.0f}m)" if best and best['cpu_m'] else ''))
cpus = [(s['rps'], s['cpu_m']) for s in summary if s['cpu_m'] and s['rps'] > 50]
if cpus:
    per = st.median(c / r for r, c in cpus)
    print(f"towerd CPU per request (median over windows with > 50 req/s): {per:.2f} millicores per req/s => one core holds ~{1000 / per:.0f} req/s")
ab = os.path.join(d, 'abort')
print('abort:', open(ab).read().strip() if os.path.exists(ab) else 'none')
