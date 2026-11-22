# How TowerOfHan scales

The short answer: listeners cost almost nothing; *distinct comments listened to* cost voice time. A hundred people
on the same three floors cost about what ten do. The only scarce thing is the voice worker, and everything below is
arranged so its seconds go where the most ears are.

## The shape

```
HN Firebase API ──► towerd (one Node process: ingest, files, two small POST endpoints)
                      │ writes var/live/: head.json (when it changes), e/<n>.json, f/<story>/<rev>.json,
                      │                    c/<id>.<rev>.p<n>.json + .ogg clips (all immutable but head)
                      │ writes var/jobs/: what to voice next, ranked
                      ▼
                    voice worker (Kokoro on CPU) ──► clips + sidecars ──► voiced.jsonl ──► towerd
browsers ──► GET static files (CDN-cacheable)  ·  POST /want (voice this table)  ·  GET /profile/<name>
```

No database, no websockets, no per-user state on the server. A browser polls `head.json` every 2 s and fetches
only what changed: deltas, audio-only patches for its floor (a few bytes), and the sidecars and clips it is about
to play. Everything except `head.json` is content-addressed and served `immutable` for a year.

## Measured (22 Nov 2026, local, one core for towerd, the real client's request pattern)

`node /tmp/tohn/load/load.mjs <base> <clients> 60 <towerd pid>`: each simulated listener polls head.json with its
ETag, follows deltas and its floor's revisions, fetches a sidecar and a clip about every 2.5 s (several tables in
earshot), asks for voicing every 30 s, and opens a card now and then.

| listeners | req/s | p50 | p99 | towerd CPU | RSS | out | errors |
|---|---|---|---|---|---|---|---|
| 100 | 121 | 1–3 ms | ≤ 17 ms | 12% of a core | 298 MB | 8 Mbit/s | 0 |
| 300 | 383 | 2–4 ms | ≤ 36 ms | 24% of a core | 302 MB | 24 Mbit/s | 0 |

The HTTP side is roughly linear: about a thousand concurrent listeners per core, about 80 Mbit/s of audio and
JSON at that point. Bandwidth runs out before CPU; a CDN removes both (below).

## What protects the scarce part (voicing)

- **Demand, not volume.** The worker voices what someone asked for (a table you sit at: 0–99; a floor you're on:
  100–199; a floor in focus on the tower: 200–999), then the first words of every table on every floor (1000+),
  and goes deeper only while anyone is around. A request lapses after 90 s unless renewed.
- **Ranked by ears.** A comment wanted by several listeners moves up eight places per extra listener (up to 30):
  with a hundred people, the worker's seconds go where most of them are listening (`crowdPrio` in towerd).
- **Openings first.** Every table can start talking at once; whole comments follow while the first plays.
- **One voicing, everyone hears it.** A clip is a static file: the hundredth listener costs a GET.
- **Graceful when behind.** `head.json` carries `load` (listener-driven comments still waiting). When it runs long,
  tables stop waiting on unvoiced lines (1.5–2 s instead of 4) and play what's ready, so the room never stalls.
- **Interruptible background work.** A clip being voiced in the background is cancelled mid-inference when a
  listener's request arrives (ONNX `RunOptions.terminate`).
- **Bounded endpoints.** `/want`: per client 1/s (burst 20) and 30/s overall. `/profile`: cached three days; on a
  miss, at most two cards are being written at once (503 + Retry-After; the client retries once), twenty model
  calls a minute.

Voicing capacity, today: Kokoro fp16 at ~1.5–1.8× real time on three cores in bursts (300 s per 10 min) plus one
background core. That is roughly 30 hours of speech a day, against ~19 hours of everything on the front page at
any moment. So not everything can be voiced, which is why the ranking matters, and why it works: people cluster.

## A public launch, with the same lean box

1. **Cloudflare in front** (orange cloud on the host). Cache rules:
   - `/assets/*`, `/live/f/*`, `/live/e/*`, `/live/c/*`: cache everything, respect origin headers (immutable).
   - `/live/head.json`: respect origin (`max-age=1, stale-while-revalidate=10`): the origin sees about one request
     a second per edge location, whatever the audience.
   - `/want`, `/profile/*`: bypass. Add an edge rate limit (e.g. 30/min per IP) as a second fence.
   - towerd already trusts `CF-Connecting-IP` only from Cloudflare's ranges, so per-client limits keep working.
2. **Then the origin's load is flat**: head.json at ~1/s per POP, immutable files once each, plus /want and /profile.
3. **Voicing** is the knob. In order of cost:
   - keep one CPU worker (as now) and let the ranking and `load` do their work;
   - a second CPU worker needs an atomic job claim (rename the job file before voicing) and ~660 MB more RAM;
   - a GPU worker (Kokoro is 50–100× real time on a small GPU) makes "everything on the front page, voiced" possible:
     a serverless GPU only while anyone is listening.
4. **Tags and cards** use Claude Haiku through auth2api (the subscription): tags are one call per batch of up to
   eight voiced comments, so they scale with voicing, not listeners. With real traffic, set `ANTHROPIC_API_KEY`
   (both towerd and the worker prefer it) so the subscription isn't shared with a launch.

## Failure modes and what happens

| situation | what the listener sees |
|---|---|
| HN API slow or down | the tower and rooms keep their last state; ingest retries with backoff |
| worker far behind | tables play what's voiced, skip what isn't after 1.5 s; openings everywhere still play |
| worker down | the same, plus only already-voiced audio; nothing breaks |
| towerd restart | ~1–2 min bootstrap; head.json and files on disk keep serving meanwhile |
| a card can't be written | the card shows without its summary |
| a burst of profile clicks | cached cards at once; new ones 503 → one retry → card without summary |
| network drops (phone) | polls fail quietly and resume; clips that fail are skipped |
| a story with no comments | an empty room that says so; lean-back moves on |
| a hot thread's flood | new comments are said next at their tables; one merged note per 45 s |
