# Tower of HN: launch readiness (26 Nov 2026)

> Status 17:05 IST: everything below is live and measured, except the capacity test (§4), which waits for a calm
> cluster; this file is updated in place when it has run.

## The answer

**Why voices felt slow.** Voice generation itself is fast enough. Two other things held it up.
- **Most of the tower wasn't voiced when you got there.**
  - Only 35% of the 3,280 comments on the tower had voices.
  - The voicing machines on the two workers sat idle 92.5% of the time. They voiced deep only while someone was
    listening, and only the best six tables per floor.
  - At any other table, every comment was voiced live while you waited: 8.5 s typical, 30 s at worst.
- **Even with everything voiced, the client added silences.**
  - a 1.6 s pause every time you sit down;
  - waits of up to 30 s while a speaker walked over from another table (31% of comments are by people seated at two
    or more tables);
  - long comments waited for every clip to download before the first could play.

**What changed** (all live, each behind a switch with a one-line rollback):
1. **Voice ahead** (`VOICE_AHEAD=all`, 14:14 IST): the whole tower is voiced as comments arrive, so listeners find it
   ready. Coverage rose from 48% at deploy to 85% by 16:50, still climbing; new comments are voiced within minutes of arriving.
2. **The client stops making you wait** (`CLIENT_FLAGS=stream,cue,quick`, 15:50 IST, after an A/B on the live site):
   - first voice 1.08 s typical (was 1.65 s);
   - p95 under 2 s on desktop and phones;
   - no silences more than 1.5 s longer than designed (was 8 in the same sample).
3. **The site has its own CPU share on kanmani** (300m request).
4. **towerd no longer blocks on the disk** (0.5.14).
5. **Voicing runs only on vizerizz**: the home box couldn't cool it (§3.2).

**Before → after**, first visit to a table, from a US machine on the tailnet (the same plan: 30 threads at three
positions each):

| | before (11:17–12:35) | after (15:51–16:51) |
|---|---|---|
| desktop: first voice p50 / p95 | 1.65 / 6.81 s | **0.91 / 1.68 s** |
| phone (Pixel 7, CPU 4× slower): p50 / p95 / worst | 1.65 / 3.35 / 6.78 s | **0.90 / 1.45 / 1.67 s** |
| first voice within 1 s (desktop / phone) | 0% / 0% | **58% / 68%** |
| first voice within 2 s (desktop / phone) | 87% / 92% | **96% / 100%** |
| tables whose first turn had no voice yet | 4–5% | **0%** |
| silences between turns >1.5 s longer than designed | 2 + 6 | **0 + 0** |

- The worst desktop sit (9.6 s) was neither the voices nor the client. Every request in flight stalled together for
  ~9 s, including `head.json`, which towerd serves from memory: a hiccup on the tailnet path or a starvation moment on
  kanmani, 1 sit in 88.
- Expect ~0.1–0.4 s less from India. These runs come from the US, ~200 ms from Singapore per round trip.

**Can it hold hundreds of people?** TBD (staging capacity test)

**Is kanmani overloaded while the others idle?** Yes, measured.
- kanmani runs 43 of the 54 pods on about 1.5 real cores. Steal took 15–73% of its CPU every day this week.
- vizerizz was 91–97% idle every day.
- Voicing now runs only on vizerizz, and the site has its own CPU share on kanmani. The rest (agentfest off kanmani,
  kubelet reservations, Traefik's share) is a plan for your OK: §5.

## 1. What a listener got (before, 26 Nov 11:17–13:08 IST)

A US machine on the tailnet sat at 46 tables on desktop and 38 as a Pixel 7 phone, across 26 threads. It sat at each
table's best, middle and deep positions, listened 35 s each, and then came back to every table a second time.

| visit | device | sits | first voice p50 | p95 | max | within 2 s | first turn not voiced yet | silences >1.5 s too long |
|---|---|---|---|---|---|---|---|---|
| first | desktop | 46 | 1.65 s | 6.81 s | 9.59 s | 87% | 4% | 2 of 45 gaps |
| first | phone | 38 | 1.65 s | 3.35 s | 6.78 s | 92% | 5% | 6 of 57 gaps (max 8.4 s) |
| second | desktop | 45 | 1.65 s | 1.81 s | 7.93 s | 96% | 0% | 2 of 52 |
| second | phone | 33 | 1.66 s | 2.69 s | 3.37 s | 82% | 0% | 3 of 46 |

Why the slow first voices were slow (desktop, first visit, over 2.5 s):
- **3 of 6: choreography.** The audio was decoded, and the speaker was walking over or talking at another table:
  5.8–7.6 s.
- **2 of 6: the first turn had no voice yet.**
  - The server took 4.8–5.0 s to voice its first clip.
  - The client noticed 1.1–1.4 s later (it polls every 2 s).
  - Then fetch and decode: about 7 s in all.
- **1 of 6: downloads.** All 14 clips of a long comment were downloaded before the first could play: 2.5 s from the US.
- **The p50 of 1.65 s is the client's own 1.6 s pause on sitting.** Fetching (0.8 s typical from the US) and decoding
  (15–40 ms) fit inside it.

## 2. Where the time went

**The voicing machines (runner logs, 24 Nov 22:09 to 26 Nov 05:37 UTC: 31.5 h, 3,001 jobs).**
- **Cost.** 13.2 h of speech made in 9.4 lane-hours. That is 7.5% of the 126 lane-hours available on the two workers
  (2 lanes each).
- **Uneven.** Without anyone listening the lanes voiced 2–4 minutes of speech an hour, just the first words of new
  tables. While someone listened, 60–150 minutes an hour.
- **Seated listeners' jobs.** 160 jobs, nearly all in your two sessions (25 Nov 19:22 UTC, 26 Nov 05:11–05:37 UTC).
  - Job time: p50 8.5 s, p95 30.5 s, p99 48 s, for p50 10.9 s of speech.
  - The comment can start playing after its first clip (≤110 characters, ~4 s of work). But the table's other turns
    queue behind it: 24 turns asked at once, 4 lanes.
  - Of all job claims, 47% waited on the tagging model (Claude Haiku; up to 2.5 s for a seat).
- **Speed per lane** (two lanes of two threads per worker): jomjom 1.72× real time, vizerizz 1.53×; whole-job average
  1.33×.
  - The kanmani standby made 0 clips (by design).
  - Model load to a ready lane: 1.7–2.4 s on the workers, 7.6 s on kanmani. No restarts since 24 Nov.
- **Uploads.** Clip uploads take ~0.2–0.5 s. jomjom's stall at times: 14 s and 21 s in this window, because it is on
  Wi-Fi.

**One clip, stage by stage** (`profile_voice.py`, one thread):
- The Kokoro model: 97–98% of the time. Its Conv layers take 54% of the model's time, quantised convs 13%, the
  vocoder's sines 7%.
- Phonemes (espeak): ~1 ms.
- The Opus encode: ~6% (it sits on the first clip's path).
- Normalising and the mouth tracks: <1 ms.
- So there is no cheap, audio-identical speed-up inside the clip. The lever is when voicing happens.

**What listeners ask for.** The comments your seated sessions asked to be voiced were p10 ~0.5 h, p50 ~6.5 h and p90
~11 h old by then: front-page threads, not brand-new comments. Everything a listener reaches could have been voiced hours
earlier.

**The tower.**
- 3,280 turns, ~15.3 h of speech; the mean turn is 16.8 s.
- Voiced: 1,062 whole and 87 openings (35%).
- New comments arrived at ~183 an hour (05:31–05:49 UTC, a quiet hour), about 0.9 h of speech an hour.

**The client, with everything voiced** (6 fully voiced tables, a US machine on the tailnet).
- First voice after sitting: p50 1.65 s, p95 7.2 s, max 8.4 s. Server time 0.
- What made up the 1.65 s:
  - the 1.6 s establishing pause (by design);
  - fetch: 1.0–1.4 s typical from the US, up to 3.3 s for a long comment's 11 clips, all fetched before the first
    could play;
  - decode: 16–88 ms.
- The 7–8 s cases:
  - one sit: turn 0 was decoded at 1.1 s, and its first voice came at 8.4 s. The speaker was called over from elsewhere.
  - one sit: 3.3 s of downloads.
- 31% of turns on the live floors are by commenters seated at two or more tables. There is one avatar each, so the
  table can wait for them to walk over, or to finish talking elsewhere: up to 30 s.
- Between turns, once audio is ready, the gaps were exactly as designed (10 gaps, ≤6 ms over).

## 3. What shipped

App releases **v0.5.13** (rounakdatta/tower-of-hn.io #12, #13) and **v0.5.14** (#16 non-blocking reads, #15 `NODE_LANES`), each
reviewed by a separate read-only reviewer before merging. Every behaviour is behind a switch in the homelab values (#378, #380,
#381, #382).

| change | switch | what it does | rollback |
|---|---|---|---|
| Voice ahead | `VOICE_AHEAD: "all"` (towerd) | The workers voice everything on the tower as it arrives: every table's first turn (top floors first) before any table's second. Listeners' requests still jump the queue. The kanmani standby only takes what a listener is waiting on and new tables' first words. | remove the env |
| Start on the first clip | `CLIENT_FLAGS` has `stream` | A comment plays from its first decoded clip; the rest join as they decode. A clip that fails ends the comment on what was said. | drop `stream` |
| No waiting on walk-overs | `CLIENT_FLAGS` has `cue` | The next two speakers are called over while the current turn plays and held for this table. A speaker still walking talks after 0.8 s; one busy at another table after 2 s, from the table. | drop `cue` |
| Shorter sit pause | `CLIENT_FLAGS` has `quick` | The first voice comes 0.6 s after sitting, under the establishing shot, instead of 1.6 s. | drop `quick` |
| The site's CPU share | towerd `requests.cpu: 300m` | Weight ~12 instead of 1 against agentfest's ~39 on kanmani. | remove the line |
| Non-blocking reads | `LIVE_READS` (async by default, 0.5.14) | A file not in towerd's memory is read without holding up other requests; `HOT_MB` sizes the memory cache. | `LIVE_READS: "sync"` |
| Runner placement | runner `replicas: 1`, not on `city=rishra`, `MAX_LANES: "2"` | Voicing on vizerizz only (§3.2). | `replicas: 2`, drop the expression |

Also new: `cover` in `/status` (how much of the tower is voiced), the switches logged at boot, `HN_API` (staging),
`?play=` for side-by-side tests, and `tools/scale/`.

## 3.1 The client flags, A/B-tested on the live site before switching them on

After voice-ahead went live, the same machine heard the same tables both ways: the old client (`?play=`) and the new
one (`?play=stream,cue,quick`). The arms were interleaved table by table, with alternating order, on 39 desktop tables
and 16 phone tables (14:15–15:41 IST).

| | old client | stream + cue + quick |
|---|---|---|
| desktop: first voice p50 / p95 / worst | 1.65 / 2.64 / 8.68 s | **1.08 / 1.99 / 2.53 s** |
| phone (Pixel 7, CPU 4× slower) | 1.66 / 2.32 / 2.65 s | **1.06 / 1.54 / 1.78 s** |
| first voice within 1 s | 0% | 46% (desktop), 50% (phone) |
| silences >1.5 s longer than designed | 4 + 4 | **0 + 0** |
| skipped turns | 1 | 0 |

**Decision rule, set before looking.** Switch on only if p50 and p95 fell on both devices, late silences didn't rise,
and nothing new broke. All held.

**One scare.** My first count showed 50 skipped turns in one phone sit. It was a reply that landed on HN 25.8 s into
the sit, which the client correctly says next (its "breaking" behaviour), not 50 turns jumped. The metric is fixed.

**Switched on at 15:50 IST** with web 0.5.14 (homelab #382).

## 3.2 An incident I caused, and what I did

**What happened.** jomjom, the home box in Rishra, reset after voice-ahead went live.
- **Before.** The runner on jomjom ran all four cores flat out from 14:14 IST to catch up the tower.
- **14:28 IST (08:58 UTC): an abrupt reset.** The journal stops mid-run with no shutdown sequence. The cameras
  (Frigate) and Home Assistant were down with it for ~10 minutes.
- **Back on its own.** It came up again at 14:39, on a newer kernel that had been installed earlier.
- **Still hot.** Ten minutes later, with the voice lanes resumed, the CPU package read 82 °C, with 6,866
  thermal-throttle events since boot.

**What I did.**
- **14:55: one lane per worker.** I cut the runners to one lane per worker (two cores instead of four).
- I applied it as a single `kubectl set env` on Tower of HN's own runner. kanmani was in a second CPU storm (load 58)
  and a full deploy would have added to it.
- Then homelab #380 made it permanent.
- jomjom then ran ~45% busy at 82–86 °C with **no throttling**, but kept climbing: 87–89 °C at 15:17.
- **~15:20: voicing off the home box.** The runner now runs only on vizerizz (one runner, two lanes): a targeted
  patch, then homelab #381.
- **Recovered.** At 15:53 jomjom read 41–46 °C, 7% busy, no throttling.

**What I can't prove.** That the load caused the reset; a power blip would look the same. But 82–86 °C at half load is
hot for that CPU (an i5-7400). Its fan or heatsink probably needs cleaning.

**What it costs.** Voicing capacity is ~3× real time (vizerizz's two lanes) instead of ~6.4×, so the catch-up took
longer. Steady state is still covered: ~3× against 0.9–3 h of new speech an hour.

**If you want jomjom back.** Clean its cooling first. The runner can then take one lane there with `NODE_LANES`
(merged, #15; it needs a voice-image bump to take effect).

## 4. Capacity: how many people one towerd holds

**The honest shape first.**
- **Voicing doesn't grow with listeners any more.** With voice-ahead, the workers voice what's on the tower whether one
  person listens or a thousand do.
- **What listeners cost is files.**
  - `head.json` every 2 s, mostly answered "not modified" in a few bytes;
  - a floor's small deltas;
  - sidecars and Ogg clips, which never change, so a browser fetches each once.
- **towerd is a single process on kanmani** with a node-local volume. It does not scale out sideways as deployed. A
  CDN in front (the public-launch plan in `docs/SCALING.md`: Cloudflare, cache rules already written) changes that: every
  edge asks the origin for `head.json` about once a second and for each clip once, whatever the audience.

**Measured on staging (vizerizz).** TBD (the test waits for a calm cluster: its first attempt refused to start while
kanmani's load was 11).

**Voicing capacity, the other half.** With jomjom out (§3.2), only vizerizz voices: two lanes, ~3× real time,
~11 turns a minute.
- That's enough for the tower's quiet hours. Unvoiced turns fell from 763 to 521 between 15:44 and 16:44 IST while new
  comments kept arriving.
- At the US-day peak it only about keeps pace. Coverage then hovers in the high 80s, and the newest comments wait minutes
  to be voiced. A listener who sits at one still gets it voiced first (they jump the queue).
- For a launch with many listeners, add voicing capacity, in order of cost:
  - jomjom's cooling cleaned, then one lane back (`NODE_LANES`, merged);
  - vizerizz at four lanes of one thread: about +25% throughput, with output equivalent but not bit-identical, to be
    verified first;
  - a small GPU runner (`KOKORO_PROVIDER=cuda`, 50–100× real time). That would make "everything voiced" hold at any
    hour.

**What that means for kanmani.** TBD

## 5. The cluster

**Seen live during this task.** At 13:26 IST kanmani went into a CPU storm of its own: load 84 (1-minute) and 70
(5-minute), tasks waiting on the CPU 94% of the time.
- A 5-second sample of the whole VM: 20% user, 14% system, 2% idle, **63% steal**.
- None of it was this task's: its tests were stopped. Inside agentfest, the visible processes were light.
- Tower of HN kept answering, slowly: head.json took 0.2–0.7 s in-cluster instead of milliseconds. Its updates fell 16 s
  behind.
- This is the pattern that preceded this week's power-cycles. Everything in the plan below is about making the site
  independent of it.

(Measured with a read-only probe at 05:35 UTC, the nodes' sysstat history from 18 to 26 Nov, and the voice runners'
logs from 24 Nov 22:09 to 26 Nov 05:37 UTC.)

### You were right: kanmani does almost all the work

| node | what it is | real CPU | 18–26 Nov, daily | right now (05:35 UTC) | pods |
|---|---|---|---|---|---|
| kanmani | Leaseweb SG VPS, 6 vCPU EPYC, 16 GB | **~1.5 cores** (steal takes the rest) | busy 16–28%, **steal 15–73%** (35–59% on 23–25 Nov) | 1.4–1.7 cores used, 9.2–9.4 GB | **43 of 54** |
| jomjom | home box in Rishra, i5-7400 4 cores, 16 GB, **on Wi-Fi** | 4 | (no sysstat installed) | 0.4–3.4 cores (voicing) | 6 |
| vizerizz | Paris VPS, Xeon Gold 6230 4 vCPU (AVX-512), 16 GB | 4, steal ≈ 0 | **91–97% idle** every day | 1.4–3.3 cores (voicing) | 4 |

Why the work lands on kanmani:
- **Volumes.** Almost every app keeps its data on a local-path volume on kanmani, and a local-path volume pins its pod
  to that node for good.
- **The control-plane selector.** Many apps also carry it deliberately: jomjom drops offline, so public apps were pinned
  to the always-there node.
- **agentfest.** The agents (Paseo, hopkins runs, every agent session) live on kanmani. agentfest is the largest
  consumer: 0.6–0.7 core on average, bursting to many cores, with 5 GB in use and a 10 GB limit.
- **k3s itself** (API server, etcd, containerd): 0.9 core on average since the last boot.
- **What's left is small.** telly takes 0.36 core, Tower of HN's web server 0.07–0.12, Nextcloud 0.08.

What protects the user-facing services when kanmani is starved: almost nothing.
- **towerd has no CPU request** (cgroup weight 1). agentfest requests a whole CPU (weight ~39). When agent jobs saturate
  the node, towerd gets about 1/40th of what agentfest gets. The Nov 24 probe timeouts fit this.
- **Traefik, the door for every site, is BestEffort** (weight 1 in a slice weighted 1 against the rest's 119).

### What I changed for Tower of HN (its own workloads only)

- **Voicing never runs on kanmani now** (`VOICE_AHEAD=all`).
  - The runner on vizerizz voices the whole tower ahead of listeners. Since ~15:20 it runs there only: the home box
    overheated, §3.2.
  - The standby lane beside the data takes only what a listener is waiting on, and new tables' first words, and only
    when the runner is gone.
- **towerd gets a CPU request of 300m** (weight ~12), so agent bursts can no longer starve the site. kanmani's CPU
  requests go from 3.03 to 3.33 of 6.

### Plan for your OK (not applied: host-level or other apps)

Each step is reversible. The A-items are from the 25 Nov kanmani report (/f/39302); they still stand.

1. **Traefik gets a CPU request (100m), so the site's door isn't last in line.** Traefik is the door for every site
   and is BestEffort today: in a storm like today's (2% idle), BestEffort pods share a slice weighted 1 against the
   other pods' 119, so the door gets close to nothing while everything behind it waits. This is the cheapest, biggest
   step for any site's availability during a storm.
   - Step: in `ansible/roles/traefik/templates/traefik-config.yaml.j2`, add to `valuesContent`:
     `resources: {requests: {cpu: 100m, memory: 64Mi}}`
   - Then `gh workflow run deploy-infra.yml -f tags=traefik` (ansible-managed; the role owns the HelmChartConfig).
   - k3s's helm controller upgrades Traefik with a rolling restart: a second or two of refused connections.
   - Rollback: remove the block and run the same workflow.
2. **Cap agentfest's CPU (A3):** `limits.cpu: "3"` in `kubernetes/apps/agentfest/values.yaml`, at its next restart, when
   no job runs.
3. **Kubelet reservations + one-process OOM kills (A4):** the drop-in file in the report, then one gated k3s restart.
4. **The big one: move agentfest off kanmani.** Two options:
   - **(a) To vizerizz** (free; it is idle 91–97% of every day).
     - agentfest gets ~2.5× the real CPU it has now.
     - kanmani gets back roughly half its CPU and 5 GB of memory.
     - Costs:
       - a tested copy of the `agentfest-home` volume (local-path, so it is a copy, not a re-attach);
       - one planned outage of every session;
       - ~150 ms more round trip from India for Paseo's streams.
     - Voicing on vizerizz would then share it with the agents. Runner lanes have no CPU request, so they yield.
   - **(b) A dedicated agent node** (the report's B2: Hetzner SG CCX23, 4 dedicated cores, ~€109/month).
   - Either way kanmani is left to k3s and the apps, and the site stops depending on what the agents are doing.
5. **Where towerd stays: kanmani.**
   - Moving it to vizerizz would give it idle cores. But every uncached request from India would cross Singapore to
     Paris and back (+~170 ms), because Traefik and the tailnet door are on kanmani.
   - With 1–4 done, towerd's ~0.1–0.5 core is safe where it is.


## 6. What's left, and what needs you

- **Your OK (§5):**
  - Traefik's CPU share. This is the biggest win for every site during kanmani's storms: two lines and one
    `deploy-infra` run.
  - agentfest's CPU cap and the kubelet reservations (the 25 Nov report's A3/A4).
  - Moving agentfest off kanmani, to vizerizz (free) or a dedicated node (~€109/mo).
- **Public launch:** put Cloudflare in front (the cache rules are already in `docs/SCALING.md`) and pick the domain.
  This turns "one towerd" into "one towerd behind a CDN": the origin's load stays flat however many people come.
- **jomjom:** clean its fan and heatsink. It ran 82–89 °C at half load and threw thousands of thermal-throttle events at
  full load.
- **Ready but not deployed:** the runner's `NODE_LANES` (#15), needed only if jomjom voices again.

## 7. How this was measured

Everything is reproducible. The harnesses are in the app repo, under `tools/scale/` (merged in #12).

- **Server side, 7 days.**
  - The nodes' own sysstat history: 10-minute CPU, steal, load, memory and network, 18–26 Nov. jomjom has no
    sysstat.
  - A read-only snapshot of the cluster: placement, requests, `kubectl top`, the kubelet stats summary.
  - The voice runners' logs: every job since they started on 24 Nov 22:09 UTC, 31.5 h, 3,001 jobs.
  - All of it went through a throwaway CI workflow whose output was encrypted to a one-day key. The public CI log shows
    step names only.
- **A listener's side (`listen.mjs`).**
  - A headless Chrome on a US machine on the tailnet opens the real client in its frame-stepped mode
    (`?record&realaudio&manual`). That runs the real code, with a real audio clock and real network, with frames
    stepped without drawing, so a GPU-less machine measures network, server and decoding, not software rendering.
  - It sits at a table (a deep link), and timestamps every fetch, decode and audio start.
  - towerd's ETags carry each file's write time, so the time the server took separates from network and client time.
  - One listener at a time. Phone runs use Chrome's Pixel 7 profile with the CPU slowed 4×.
- **Where a clip's time goes (`profile_voice.py`):** one clip made exactly as a runner makes it, stage by stage, with
  ONNX Runtime's own per-operator profile.
- **Capacity (`load.mjs`, the `tohn-scale-staging` workflow):**
  - **Setup.** A staging towerd of its own, in its own namespace with a quota, on vizerizz. It reads a mock of HN
    (`mockhn.mjs`, never the real one) and serves a `/data` seeded with synthetic audio of real sizes (`seed.mjs`).
  - **The load.** Simulated listeners do what the client does, at the client's pace. Their rate was calibrated
    against the real client: seated, ~3 requests a second and ~260 kbit/s in the first minute, because the room
    plays the three nearest tables too. They run from a US machine over the tailnet, ramped gradually.
  - **Aborts.** Any node's 5-minute load over 70% of its cores, memory over 85%, or a failing production check stops
    the test. kanmani's own load is already above 70% of its ~1.5 real cores, and the test never touches it, so for
    kanmani the rule is any rise over its pre-test level.
  - The namespace is deleted at the end.
