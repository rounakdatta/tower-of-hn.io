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
