#!/usr/bin/env python3
"""Side by side: what a listener got in each run (before; the server fix; server and client fixes), from listen.mjs
records via analyze.py's sit_metrics. One row per group: sits, first voice after sitting (p50/p95/max), how often it
came within 1 s / 2 s, the share whose first turn had to be voiced on demand, and the silences between turns.

usage: compare.py LABEL=FILE[,FILE...][@arm] ...   e.g. before=cold-desk.jsonl after=ab-desk.jsonl@B"""
import json, sys, importlib.util, pathlib

here = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('analyze', here / 'analyze.py')
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)


def rows_of(files, arm):
    out = []
    for f in files:
        for line in open(f):
            r = json.loads(line)
            if r.get('skipped') or not r.get('log') or not r.get('tSit'):
                continue
            if arm and r.get('arm') != arm:
                continue
            m = A.sit_metrics(r, r['tSit'], r['table'], r.get('tNext') or r['tEnd'])
            m['mobile'] = r.get('mobile')
            out.append(m)
    return out


def fmt(xs, q):
    v = A.pct(xs, q)
    return '-' if v is None else f'{v / 1000:.2f}'


print(f"{'run':24} {'device':7} {'sits':>4} {'heard':>5} | {'first voice p50':>15} {'p95':>6} {'max':>6} | {'<=1s':>5} {'<=2s':>5} | {'on demand':>9} | {'gaps':>4} {'>1.5s late':>10} {'skips':>5}")
for arg in sys.argv[1:]:
    label, _, spec_ = arg.partition('=')
    files, _, arm = spec_.partition('@')
    rows = rows_of(files.split(','), arm or None)
    for mobile in (False, True):
        rs = [x for x in rows if bool(x.get('mobile')) == mobile]
        if not rs:
            continue
        first = [x['first_ms'] for x in rs if x.get('first_ms') is not None]
        gaps = [g for x in rs for g in x.get('gaps', [])]
        od = [x for x in rs if x.get('ready_before') is False]
        print(f"{label:24} {'phone' if mobile else 'desktop':7} {len(rs):4} {len(first):5} | {fmt(first, .5):>15} {fmt(first, .95):>6} {fmt(first, 1):>6} | "
              f"{100 * sum(1 for v in first if v <= 1000) / max(1, len(first)):4.0f}% {100 * sum(1 for v in first if v <= 2000) / max(1, len(first)):4.0f}% | "
              f"{100 * len(od) / max(1, len(rs)):8.0f}% | {len(gaps):4} {sum(1 for g in gaps if g['excess'] > 1500):10} {sum(x.get('skips', 0) for x in rs):5}")
print('(seconds; first voice = sitting down to the table\'s first voice; on demand = its first turn had no audio yet; '
      'late = a silence between turns longer than designed by more than 1.5 s)')
