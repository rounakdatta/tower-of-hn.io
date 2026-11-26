#!/usr/bin/env python3
"""Runner log -> per-job table and a summary by priority band (Tower of HN launch readiness, phase 1a).
usage: runner_jobs.py LOG [LOG...]"""
import json, sys, statistics as st, collections, datetime as dt

def band(p):
    return 'seat' if p < 100 else 'floor' if p < 200 else 'focus' if p < 1000 else 'bg'

def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))] if xs else float('nan')

jobs = []
for path in sys.argv[1:]:
    for line in open(path, errors='replace'):
        ts, _, rest = line.partition(' ')
        if not rest.startswith('{"id"'):
            continue
        try:
            j = json.loads(rest)
        except ValueError:
            continue
        j['t'] = dt.datetime.fromisoformat(ts[:26].rstrip('Z')).replace(tzinfo=dt.timezone.utc).timestamp()
        j['outcome'] = next(k for k in ('done', 'opened', 'yielded', 'lost') if k in j) if any(k in j for k in ('done', 'opened', 'yielded', 'lost')) else [k for k, v in j.items() if v is True][0]
        j['node'] = j['lane'].split('/')[0]
        j['band'] = band(j.get('prio') or 0)
        jobs.append(j)
jobs.sort(key=lambda j: j['t'])
t0, t1 = jobs[0]['t'], jobs[-1]['t']
print(f"jobs {len(jobs)} from {dt.datetime.utcfromtimestamp(t0):%d %b %H:%M} to {dt.datetime.utcfromtimestamp(t1):%d %b %H:%M} UTC ({(t1-t0)/3600:.1f} h)")
print('outcomes', dict(collections.Counter(j['outcome'] for j in jobs)))
print('by band ', dict(collections.Counter(j['band'] for j in jobs)))
print()
print(f"{'band':6} {'outcome':8} {'n':>5} {'audio p50':>9} {'wall p50':>8} {'wall p95':>8} {'wall p99':>8} {'rtf p50':>7} {'rtf p5':>6} {'up ms p50':>9} {'up p95':>7}")
for b in ('seat', 'floor', 'focus', 'bg'):
    for o in ('done', 'opened', 'yielded', 'lost'):
        xs = [j for j in jobs if j['band'] == b and j['outcome'] == o]
        if not xs:
            continue
        w = [j['wall_s'] for j in xs]; a = [j['audio_s'] for j in xs]
        r = [j['audio_s'] / j['wall_s'] for j in xs if j['wall_s'] > 0 and j['audio_s'] > 0]
        u = [j['upload_ms'] for j in xs if j.get('upload_ms')]
        print(f"{b:6} {o:8} {len(xs):5} {pct(a,.5):9.1f} {pct(w,.5):8.1f} {pct(w,.95):8.1f} {pct(w,.99):8.1f} {pct(r,.5):7.2f} {pct(r,.05):6.2f} {pct(u,.5):9.0f} {pct(u,.95):7.0f}")
print()
print('per node: jobs, audio h, busy h (sum wall), rtf (sum audio / sum wall)')
for n in sorted({j['node'] for j in jobs}):
    xs = [j for j in jobs if j['node'] == n]
    a = sum(j['audio_s'] for j in xs); w = sum(j['wall_s'] for j in xs)
    print(f"  {n:9} {len(xs):5} {a/3600:6.2f} {w/3600:6.2f} {a/w if w else 0:5.2f}")
# per hour: audio voiced (h) and lane-busy fraction
print()
print('per hour (UTC): jobs, audio min voiced, lane-busy % (sum wall / (4 lanes x 3600)), seat/floor jobs')
hours = collections.defaultdict(list)
for j in jobs:
    hours[int(j['t'] // 3600)].append(j)
for h in sorted(hours):
    xs = hours[h]
    print(f"  {dt.datetime.utcfromtimestamp(h*3600):%d %H}h {len(xs):4} {sum(j['audio_s'] for j in xs)/60:6.1f} {100*sum(j['wall_s'] for j in xs)/(4*3600):5.0f}% {sum(1 for j in xs if j['band'] in ('seat','floor')):4}")
json.dump(jobs, open('/tmp/tohn-jobs.json', 'w'))
