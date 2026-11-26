#!/usr/bin/env python3
"""How many lanes a runner starts: NODE_LANES caps one node (a home box that runs hot), MAX_LANES the rest, LANES wins.
Runs without the voice stack (numpy and soundfile are stubbed): `python3 apps/voice-worker/test_config.py`."""
import importlib.util, os, pathlib, sys, types

for m in ('numpy', 'soundfile'):
    sys.modules.setdefault(m, types.ModuleType(m))
spec = importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).with_name('worker.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

assert w.node_lanes('jomjom', 'jomjom=1,vizerizz=2') == 1
assert w.node_lanes('vizerizz', 'jomjom=1, vizerizz=2') == 2
assert w.node_lanes('kanmani', 'jomjom=1') is None
assert w.node_lanes('jomjom', '') is None and w.node_lanes('jomjom', None) is None
assert w.node_lanes('jomjom', 'jomjom = 1') == 1                    # spaces round the name are fine
assert w.node_lanes('jomjom', 'jomjom=0') == 1 and w.node_lanes('jomjom', 'jomjom=x') == 1 and w.node_lanes('jomjom', 'jomjom=²') == 1   # a bad cap stays a cap
assert w.node_lanes('vizerizz', 'jomjom=x') is None                  # someone else's typo isn't ours

w.cpus_allowed = lambda: 4
cases = [
    ({'MAX_LANES': '2', 'NODE_LANES': 'jomjom=1'}, 'jomjom', 1),     # the hot box: one lane
    ({'MAX_LANES': '2', 'NODE_LANES': 'jomjom=1'}, 'vizerizz', 2),   # everyone else: MAX_LANES
    ({'MAX_LANES': '4'}, 'jomjom', 2),                               # no cap: as many as the cores allow (4 // 2)
    ({'LANES': '1', 'NODE_LANES': 'jomjom=3'}, 'jomjom', 1),         # LANES is exact
    ({'LANES': '2', 'MAX_LANES': 'auto'}, 'jomjom', 2),              # LANES set: MAX_LANES isn't even read
]
for env, node, want in cases:
    os.environ.clear(); os.environ.update(env); os.environ.update({'NODE_NAME': node, 'THREADS': '2'})
    got = w.config()['lanes']
    assert got == want, (env, node, got, want)
print('worker config: ok')
