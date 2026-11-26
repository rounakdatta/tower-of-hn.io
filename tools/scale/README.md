# tools/scale: measuring Tower of HN for launch

Harnesses used to measure the listener's experience and the voicing pipeline (launch readiness, Nov 2026).
Read-only against production; one listener at a time.

- `listen.mjs` + `probe-init.js`: a headless Chrome sits at real tables of the live tower, the client in its
  frame-stepped mode (`?record&realaudio&manual`: the real code, a real audio clock, frames stepped without drawing,
  so a GPU-less machine measures network, server and decoding, not software rendering). Every fetch, decode and audio
  start is timestamped; towerd's ETags give each file's server mtime (base 36), so server time splits from the rest.
- `plan.mjs`: a listening plan from the live tower (tables at given positions of each floor's ranking).
- `analyze.py`: first voice after sitting (cold = the first listener, warm = a second visit), split into server,
  learning (polling), fetch, decode and the director's own pacing; gaps between turns, underruns and skips.
- `runner_jobs.py`: per-job voicing stats from the runners' logs (by priority band and node).
- `heavy.sh`: run one heavy local step carefully (refuses when the box is busy; nice, ionice, time limit, memory cap).

Staging and load (never production, never the real HN; see the staging workflow in the homelab repo's throwaway
branch):
- `capture.mjs`: one gentle snapshot of the front page from HN's public API (about one towerd start-up's reads).
- `mockhn.mjs`: serves that snapshot as HN's API (towerd's `HN_API`), live: the newest comments are held back and
  released at a set rate, as new comments arrive on HN.
- `seed.mjs`: a staging towerd's `/data` as if everything were voiced (`VOICE_AHEAD=all`, caught up): sidecars, clips
  and voiced.jsonl with real shapes and sizes, synthetic bytes, towerd's own comment versions.
- `load.mjs`: simulated listeners doing what the client does at its own pace (head.json every 2 s with ETags, deltas,
  floors, a table's sidecars and clips a few turns ahead in real time, /want renewals, the room's murmur, moving on),
  each with its own connections, address and cache. Prints per-kind p50/p95/p99 every 10 s.

Afterwards:
- `compare.py`: runs side by side (before, the server fix, server and client fixes): first voice p50/p95/max, the share
  within 1 s and 2 s, the share whose first turn had to be voiced on demand, late silences between turns.
- `verify_deploy.sh`: after a release, from inside the cluster: towerd's mode, coverage and lanes, the head's age and
  flags, /livez, and the tailnet door.
- `cover_watch.sh`: every 2 minutes, how much of the tower is voiced (one in-cluster GET), to a JSONL file.
- `calm.sh`: waits until this node's 5-minute load has stayed under a bound for five minutes (before a deploy or a test).
