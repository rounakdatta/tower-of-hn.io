# How Tower of HN scales

The short answer: listeners cost almost nothing; *distinct comments listened to* cost voice time. A hundred people
on the same three floors cost about what ten do. The only scarce thing is voicing, so it runs on every node that has
cores to spare, and everything below is arranged so its seconds go where the most ears are.

## The shape

```
HN Firebase API ──► towerd (one Node process: ingest, files, the voice queue, two small POST endpoints)
                      │ writes var/live/: head.json (when it changes), e/<n>.json, f/<story>/<rev>.json,
                      │                    c/<id>.<rev>.p<n>.json + .ogg clips (all immutable but head)
                      │ plans what to voice next, ranked, and tags it (Claude Haiku, a table at a time)
                      ▼ voice port :8788 (in-cluster only)
            runners on every worker node ── claim a comment (long poll) · beat · send each clip · done
            (Kokoro lanes, two cores each)    towerd writes the clip, the floor hears of it on the next tick
browsers ──► GET static files (CDN-cacheable)  ·  POST /want (voice this table)  ·  GET /profile/<name>
```

No database, no websockets, no per-user state on the server. A browser polls `head.json` (every 2 s in a room, 4 s
on the tower, 10 s from a background tab) and fetches only what changed: deltas, audio-only patches for its floor (a
few bytes), and the sidecars and clips it is about to play. Everything except `head.json` is content-addressed and
served `immutable` for a year.

Per listener, the bytes are mostly speech: clips are Opus at ~26 kbps (compression level 0.92; libsndfile's default
is ~36 kbps for the same 8 kHz of speech, and the top of the voice starts to go only from 0.94). Brotli for the live
JSON was measured and dropped: 1–5% smaller than gzip, not worth the CPU.

## Measured (22 Nov 2026, local, one core for towerd, the real client's request pattern)

`node /tmp/tohn/load/load.mjs <base> <clients> 60 <towerd pid>`: each simulated listener polls head.json with its
ETag, follows deltas and its floor's revisions, fetches a sidecar and a clip about every 2.5 s (several tables in
earshot), asks for voicing every 30 s, and opens a card now and then.

| listeners | req/s | p50 | p99 | towerd CPU | RSS | out | errors |
|---|---|---|---|---|---|---|---|
| 100 | 121 | 1–3 ms | ≤ 17 ms | 12% of a core | 298 MB | 8 Mbit/s | 0 |
| 300 | 383 | 2–4 ms | ≤ 36 ms | 24% of a core | 302 MB | 24 Mbit/s | 0 |
| 1000 (before the hot cache) | 1091 | 4–8 ms | up to 1.2 s | 39% of a core | 360 MB | 73 Mbit/s | 0 |
| **1000** (two load generators of 500) | 1108 | 2–4 ms | 24–82 ms | 30% of a core | 335 MB | 69 Mbit/s | 0 |

What fixed the thousand-listener tail:
- **Hot files in memory.** Everything under /live/ is immutable except head.json, so towerd keeps what it has
  served or written in a 48 MB LRU and stops touching the disk on the hot path. Takedowns and prunes drop what they
  delete.
- **A debounced queue.** A burst of /want requests rebuilds the job queue once, 250 ms later, instead of walking
  every floor and writing job files once per request.

Bandwidth runs out before CPU; a CDN removes both (below).

## Voicing on every node

towerd stays the only writer of `/data` (a node-local volume on the control plane); runners are stateless and can run
anywhere in the cluster. A runner is a few processes ("lanes"), each with its own Kokoro session on two cores.
- **Claim with a lease.** A lane long-polls `/voice/claim` and gets the most urgent comment nobody holds, with its tags
  and, if someone started it before, where they stopped. It beats once a second; a lease that stops beating (a node
  dropped off) lapses after 20 s, and the comment resumes elsewhere from its last finished clip, in the same voice.
- **Clips as they're made.** Each clip goes to towerd the moment it's voiced, with a snapshot of what's playable so
  far; a long comment plays from its first sentence while the rest is voiced.
- **Urgent work never waits behind background work.** When someone sits at a table and no lane is free, the least
  urgent comment being voiced yields mid-clip (ONNX `RunOptions.terminate`), one per urgent comment, never all of them.
- **A standby beside the data.** The control plane keeps one one-thread lane that takes nothing while any runner has
  been heard from (asking, waiting or beating) in the last 15 s, and everything once they've gone quiet (both
  workers down). Same image and model, so the voices match.
- **Nothing to steal.** Runners have no volume, no keys and no internet: a NetworkPolicy lets them reach towerd's voice
  port and DNS, nothing else. Tags are towerd's job (the key stays in one place).
- `GET /voice/status` on the voice port shows every lane: its node, cores, clips and real-time factor.

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
  listener's request arrives and no lane is free (ONNX `RunOptions.terminate`).
- **Bounded endpoints.** `/want`: per client 1/s (burst 20) and 60/s overall (burst 240). `/profile`: cached three days; on a
  miss, at most two cards are being written at once (503 + Retry-After; the client retries once), twenty model
  calls a minute.

Voicing capacity, measured 23 Nov 2026: a Kokoro fp16 lane on two cores voices 1.72× real time on the Rishra worker
and 1.54× on the Paris one; each runs two lanes (four cores), so ~6.5× real time in all. The control plane only stands
by (its one thread managed 0.31× under its throttling). Until 0.5 it all ran on the
control plane, a VPS that throttles sustained multi-core load: ~0.9× real time on one core, 1.8× in rationed bursts.
Everything on the front page is ~19 hours of speech at any moment, so the ranking still matters: people cluster.

## A public launch, with the same lean box

1. **Cloudflare in front, through a Cloudflare Tunnel** (homelab: the `cloudflared` connector beside towerd).
   - No new door on the host: the connector dials out to Cloudflare and reaches towerd's `EDGE_PORT` inside the
     cluster. The NetworkPolicy admits the connector alone to that port, so towerd trusts `CF-Connecting-IP` there:
     per-visitor limits and "who is listening" keep working. `/status` is not served on it.
   - Cache rule (JSON is not cached by Cloudflare by default): `/live/*` and `/assets/*` eligible for cache,
     respecting the origin's headers. Immutable files are then cached a year; `head.json`
     (`max-age=1, stale-while-revalidate=10`) about a second, so the origin sees about one request a second per edge
     location, whatever the audience, and a new comment still reaches a listener within one poll (2 s) plus ~1 s.
   - `/want`, `/profile/*` are POSTs or `no-store`, so they always reach towerd; its own buckets limit them.
   - towerd also still trusts `CF-Connecting-IP` from Cloudflare's ranges on the main port (an orange-cloud setup
     without the tunnel).
2. **Then the origin's load is flat**: head.json at ~1/s per POP, immutable files once each, plus /want and /profile.
3. **Voicing** is the knob. In order of cost:
   - more runners: any node that joins the cluster gets one (one per worker node), with lanes for its cores;
   - a GPU runner (Kokoro is 50–100× real time on a small GPU; `KOKORO_PROVIDER=cuda`) makes "everything on the
     front page, voiced" possible: it only needs to reach the voice port.
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
