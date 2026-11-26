#!/usr/bin/env python3
"""Tower of HN listening probe: from listen.mjs records to the listener's experience, split into where the time went.

Per sit (cold = a fresh browser at a deep-linked table; warm = the next table in the same page, after 'N'):
  first_ms      sit (or N) -> the seated table's first voice starts (the client's scheduled start + output latency)
  ready_before  was that turn's audio on the server before the sit? (its first clip's ETag mtime < sit)
  server_ms     sit -> its first clip existed on the server (0 if it was there before)
  learn_ms      server ready -> the client knew (the floor or delta that carried it arrived)
  fetch_ms      knew -> its sidecar and clips fetched (all of the snapshot's clips: the director waits for them)
  decode_ms     fetched -> decoded
  sched_ms      decoded -> playing (the director's pacing: the 1.6 s establishing pause, the room's timing)
Between turns at the seated table: gap = next turn's first voice - previous turn's last clip end; excess = gap -
the designed pause (gapMs of the turn); an underrun is an excess over 1.5 s; a skip is a turn the director passed over.

usage: analyze.py OUT.jsonl [OUT2.jsonl ...]   (prints a summary; --json for machine-readable)"""
import json, re, sys, statistics as st

CLIP = re.compile(r'/live/c/(\d+)\.([0-9a-f]+)\.(\d+)\.ogg$')
SIDE = re.compile(r'/live/c/(\d+)\.([0-9a-f]+)(?:\.p(\d+))?\.json$')


def etag_ms(e):
    m = re.match(r'W/"([0-9a-z]+)-', e or '')
    return int(m.group(1), 36) if m else None


def pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    lo, hi = int(k), min(len(xs) - 1, int(k) + 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def table_turns(log, root, before):
    """the seated table's turns as the client last knew them before `before`: [(id, path, gapMs)]"""
    best = None
    for e in log:
        if e['k'] == 'fetch' and e.get('floor') and e.get('te', 1e18) <= before:
            for t in e['floor']['tables']:
                if t['root'] == root:
                    best = t['turns']
    return best or []


def sit_metrics(rec, t_sit, root, t_stop):
    log = rec['log']
    turns = table_turns(log, root, t_sit + 60_000)
    ids = [t[0] for t in turns]
    pos = {i: k for k, i in enumerate(ids)}
    starts = sorted((e for e in log if e['k'] == 'start' and t_sit <= e['at'] <= t_stop), key=lambda e: e['at'])
    mine = [(e, int(CLIP.search(e['url']).group(1))) for e in starts if CLIP.search(e['url']) and int(CLIP.search(e['url']).group(1)) in pos]
    out = {'turns': len(ids)}
    if not mine:
        out['first_ms'] = None
        return out
    e0, cid = mine[0]
    out['first_ms'] = e0['at'] + 1000 * (e0.get('lat') or 0) - t_sit
    out['first_turn'] = pos[cid]
    # where the time went for that first turn
    clip_fetch = [e for e in log if e['k'] == 'fetch' and CLIP.search(e['url'] or '') and int(CLIP.search(e['url']).group(1)) == cid]
    side_fetch = [e for e in log if e['k'] == 'fetch' and SIDE.search(e['url'] or '') and int(SIDE.search(e['url']).group(1)) == cid]
    dec = [e for e in log if e['k'] == 'decode' and e.get('url') and CLIP.search(e['url']) and int(CLIP.search(e['url']).group(1)) == cid]
    c0 = next((e for e in clip_fetch if e['url'].endswith('.0.ogg')), None)
    srv = etag_ms(c0['etag']) if c0 else None
    out['ready_before'] = srv is not None and srv < t_sit
    out['server_ms'] = max(0, srv - t_sit) if srv else None
    # when the client first knew the turn was voiced: the earliest floor/delta/head-driven fetch carrying it
    knew = None
    for e in log:
        if e['k'] != 'fetch' or 'te' not in e:
            continue
        if e.get('floor'):
            for t in e['floor']['tables']:
                for u in t['turns']:
                    if u[0] == cid and u[1]:
                        knew = e['te'] if knew is None else min(knew, e['te'])
        if e.get('delta'):
            for p in e['delta']['patches']:
                if any(i == cid and v for i, v in p['v']):
                    knew = e['te'] if knew is None else min(knew, e['te'])
    first_side = min((e['t0'] for e in side_fetch), default=None)
    knew = knew if knew is not None else first_side
    if srv and knew:
        out['learn_ms'] = max(0, knew - max(srv, t_sit))
    ends = [e['te'] for e in side_fetch + clip_fetch if e.get('te') and e['t0'] >= (knew or 0) - 5]
    fetched = max(ends) if ends else None
    if knew and fetched:
        out['fetch_ms'] = max(0, fetched - max(knew, t_sit))
    decoded = max((e['t1'] for e in dec), default=None)
    if fetched and decoded:
        out['decode_ms'] = max(0, decoded - max(fetched, t_sit))
    if decoded:
        out['sched_ms'] = max(0, e0['at'] - max(decoded, t_sit))
    out['clips_fetched'] = len(clip_fetch)
    out['clip_bytes'] = sum(e.get('bytes') or 0 for e in clip_fetch)
    # turn by turn: gaps and skips
    by_turn = {}
    for e, i in mine:
        by_turn.setdefault(i, []).append(e)
    order = sorted(by_turn, key=lambda i: by_turn[i][0]['at'])
    gaps, skips = [], 0
    def decoded_at(i, k=0):
        """when clip k of comment i was first decoded (None: never seen)"""
        ts = [e['t1'] for e in log if e['k'] == 'decode' and e.get('url') and CLIP.search(e['url'])
              and int(CLIP.search(e['url']).group(1)) == i and int(CLIP.search(e['url']).group(3)) == k]
        return min(ts) if ts else None
    for a, b in zip(order, order[1:]):
        end_a = max(x['at'] + 1000 * x['dur'] for x in by_turn[a])
        gap = by_turn[b][0]['at'] - end_a
        design = turns[pos[b]][2] if pos[b] < len(turns) else 0
        # was the next turn's first clip decoded before the silence began? then any excess is the table's choreography
        # (someone walking over, a speaker busy at another table, a pause), not voicing or the network
        dec = decoded_at(b)
        cause = 'choreography' if dec is not None and dec <= end_a + 100 else 'audio-late'
        gaps.append({'gap': gap, 'design': design, 'excess': gap - design, 'cause': cause, 'ready_ms': None if dec is None else dec - end_a})
        skips += max(0, pos[b] - pos[a] - 1)
    out['gaps'] = gaps
    out['skips'] = skips
    out['played_turns'] = len(order)
    return out


def main():
    recs = []
    for p in [a for a in sys.argv[1:] if not a.startswith('--')]:
        recs += [json.loads(l) for l in open(p) if l.strip()]
    rows = []
    for r in recs:
        if r.get('skipped') or not r.get('log') or not r.get('tSit'):
            rows.append({'label': r.get('label'), 'error': r.get('error') or r.get('skipped')})
            continue
        stop = r.get('tNext') or r['tEnd']
        cold = sit_metrics(r, r['tSit'], r['table'], stop)
        cold.update(kind='cold', label=r['label'], mobile=r.get('mobile'), story=r['story'], table=r['table'], arm=r.get('arm'))
        rows.append(cold)
        if r.get('tNext'):
            # the next table: whichever the director sat at after N (the first table whose turn plays after tNext)
            nxt = None
            for e in sorted((e for e in r['log'] if e['k'] == 'fetch' and e['method'] == 'POST' and e['t0'] >= r['tNext']), key=lambda e: e['t0']):
                pass
            # find the root from the floor data: the first started clip after tNext not of the cold table
            cold_ids = {u[0] for u in table_turns(r['log'], r['table'], r['tNext'])}
            later = sorted((e for e in r['log'] if e['k'] == 'start' and e['at'] >= r['tNext']), key=lambda e: e['at'])
            fl = [e for e in r['log'] if e['k'] == 'fetch' and e.get('floor') and e.get('te', 1e18) <= r['tNext'] + 60_000]
            roots = {}
            if fl:
                for t in fl[-1]['floor']['tables']:
                    for u in t['turns']:
                        roots[u[0]] = t['root']
            convo = [t['root'] for t in (fl[-1]['floor']['tables'] if fl else []) if len(t['turns']) >= 2]
            try:
                nxt = convo[(convo.index(r['table']) + 1) % len(convo)]
            except ValueError:
                nxt = None
            if nxt:
                warm = sit_metrics(r, r['tNext'], nxt, r['tEnd'])
                warm.update(kind='warm', label=r['label'], mobile=r.get('mobile'), story=r['story'], table=nxt)
                rows.append(warm)
    if '--json' in sys.argv:
        print(json.dumps(rows))
        return
    def line(name, xs):
        xs = [x for x in xs if x is not None]
        if not xs:
            return f'{name:34} n=0'
        return f'{name:34} n={len(xs):3}  p50 {pct(xs,.5):7.0f}  p95 {pct(xs,.95):7.0f}  max {max(xs):7.0f}'
    arms = sorted({x.get('arm') for x in rows if x.get('kind')}, key=lambda a: a or '')
    for mobile in (False, True):
        for kind in ('cold', 'warm'):
          for arm in arms:
            rs = [x for x in rows if x.get('kind') == kind and bool(x.get('mobile')) == mobile and x.get('arm') == arm]
            if not rs:
                continue
            print(f"\n== {'phone (Pixel 7, CPU 4x slower)' if mobile else 'desktop'} · {kind}{' · arm ' + arm if arm else ''}: {len(rs)} sits, {sum(1 for x in rs if x.get('first_ms') is None)} with no voice heard")
            for ready in (True, False):
                sub = [x for x in rs if x.get('ready_before') is ready]
                if not sub:
                    continue
                print(f"  first turn {'already voiced' if ready else 'voiced on demand'}: {len(sub)}")
                for k in ('first_ms', 'server_ms', 'learn_ms', 'fetch_ms', 'decode_ms', 'sched_ms'):
                    print('    ' + line(k, [x.get(k) for x in sub]))
            gaps = [g for x in rs for g in x.get('gaps', [])]
            print('  ' + line('gap between turns (ms)', [g['gap'] for g in gaps]))
            print('  ' + line('excess over designed pause (ms)', [g['excess'] for g in gaps]))
            print(f"  underruns (excess > 1.5 s): {sum(1 for g in gaps if g['excess'] > 1500)} of {len(gaps)} gaps; skipped turns: {sum(x.get('skips', 0) for x in rs)}")
            for cause in ('audio-late', 'choreography'):
                sub = [g for g in gaps if g.get('cause') == cause]
                if sub:
                    print('    ' + line(f'excess when {cause}', [g['excess'] for g in sub]) + f"  (> 1.5 s: {sum(1 for g in sub if g['excess'] > 1500)})")
    errs = [x for x in rows if x.get('error')]
    if errs:
        print('\nerrors/skips:', len(errs), [x['error'][:60] for x in errs[:5]])


if __name__ == '__main__':
    main()
