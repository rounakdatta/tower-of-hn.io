# Voiced audio on disk

How towerd keeps the audio it voices, why it stays on the server's own disk, and what to do when something looks
wrong. Written 24 Nov 2026; the code is `apps/towerd/src/store.ts` and `prune()` in `main.ts`.

## The rule

A clip can only be played from a floor of the tower. The client opens nothing else, deep links included: `sync.ts`
loads only the floors in `head.floors`, and `?story=` works only for a story on the tower. So audio is kept exactly
as long as a floor can still play it.

- **While its story is on the tower**, whatever its age.
- **For `AUDIO_GRACE_HOURS` (24) after** the last time a floor played it. A story that slips off the front page can
  come back within hours, and an edited comment's previous version may still be mid-play. After a restart, a story
  that had already left is dated by its newest floor file, which lives on the same disk.
- **Then it goes**, at the second housekeeping pass in a row (they run 10 min apart) that finds it unplayable. So
  nothing just voiced, or not yet on a floor rebuilt after a restart, is ever caught in between.
- `RETENTION_DAYS` (7) still deletes anything older, as before.

Two limits make the bound absolute:

- **`AUDIO_MAX_MB` (1024).** Over it, the audio unplayable longest goes at once. The tower's own audio is never
  evicted: if it alone were over the cap, towerd would voice nothing new until it wasn't.
- **`DISK_FREE_MIN_PCT` (15).** Below this much free space on the volume's filesystem, whatever filled it, towerd
  hands runners no jobs, refuses their clips (507: the runner gives the job back) and drops whatever nobody can play
  without waiting out the grace. On k3s the images share that filesystem, and kubelet starts evicting pods when it
  has less than 15% free (`imagefs.available`), so towerd stops before the node gets there.

The voiced log (`voiced.jsonl`, read whole at start-up) is rewritten without the lines of deleted audio once half
of it is dead.

`AUDIO_POLICY` switches it all: `age` (the default: the old rule, `RETENTION_DAYS` only), `tower-dry` (works
everything out and logs it, but deletes and holds nothing) and `tower`. The bytes a listener gets never change:
nothing is re-encoded, and the serving path is the same.

## Before (measured on the volume, 24 Nov 2026)

- `/data` held 456 MB: 17,025 clips (399 MB), 9,731 sidecars and snapshots (44 MB), floors (10 MB) and
  `voiced.jsonl` (2.4 MB, 17,568 lines).
- **Only 22% of the audio could be played.** The rest belonged to stories off the tower (hours to days) or
  already forgotten.
- Voicing ran at 43–150 MB a day (peak hour: 1,323 clips, 26 MB), Ogg Opus at 27.6 kbps, 5.7 s and 20 KB a clip.
- Nothing bounded it but age. With 7 days' retention the volume was heading for 7 days of voicing: about
  0.5–1 GB at that pace, about 13 GB if the runners voiced all day (≈1.9 GB a day). A faster voicer (more nodes,
  a GPU) raised that linearly, on the control plane's disk.
- Exact duplicates: none. The same words in the same voice and mood, voiced twice: 1.8% of clips, nearly all
  comments voiced again after an edit on HN.

## Why not R2

R2 was the obvious candidate, and the numbers rule it out for now:

- **Nothing to move.** What R2 would hold is the part nobody can play. The playable part (~90 MB) has to stay next
  to towerd anyway, where a clip costs 1–6 ms inside the cluster.
- **It would be slower.** Almost every clip is heard once, soon after it's voiced, so nearly every play from R2
  would be a Cloudflare cache miss (edge, then R2, then back).
- **It would make the audio public**, and the app is tailnet-only.
- **It saves nothing:** about $0 either way.

That changes when the app goes public behind Cloudflare: its terms want audio served from R2, not proxied (see
DEPLOY.md). Then towerd, the only writer, also puts each clip in R2, clips are served from a custom domain, the
same rule decides what to keep, and an R2 lifecycle rule drops the rest.

## Runbook

- **Look:** `curl -s towerofhan.apps.svc.cluster.local:8787/status | jq .audio`
  - `policy`; `held` (null, `disk` or `full`); `free_pct` of the volume's filesystem
  - from the last pass: `versions`, `mb` on disk, `tower_mb` (playable now), `kept_mb`, `drop` and `drop_mb`, `marked`
    (to go at the next pass)
  - since start: `dropped`, and `gets`: clip requests served from `memory` or `disk`, `missing` (a listener asked
    for audio that's gone) and by the clip's `age`
  - logs: one `{"audio": …}` line per pass, and one whenever a hold starts or ends.
- **`gets.missing` climbing:** listeners are asking for audio that's gone. A few are normal right after a takedown.
  If it keeps climbing with the policy on, roll back (below) and look at `gets.age`.
- **`held: "disk"`:** the node's disk is nearly full. Voicing has stopped; what's voiced still plays. Free space on
  the node (towerd's audio is capped, so it isn't the cause). Voicing resumes by itself within 5 s.
- **`held: "full"`:** the tower alone has more than `AUDIO_MAX_MB` of audio (about 90 MB on 24 Nov). Raise it.
- **Roll back:** set `AUDIO_POLICY: age` (or remove it) in homelab.setup's `values.yaml` and deploy. Deleted audio
  doesn't come back, but none of it could be played, and a story that returns is voiced again on demand.
