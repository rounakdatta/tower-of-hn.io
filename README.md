# TowerOfHan.io

Hacker News as a living tower. Every floor is a front-page story, every table is a thread, and the people at it speak their comments, verbatim, in their own voices, as the conversation happens.

## See it

[`docs/img/first-cut.mp4`](docs/img/first-cut.mp4) is 51 s with sound: tonight's front page, a ride up to floor #1, and a table talking in its own voices. It was rendered headlessly on a software GPU, so it looks softer and slower than on a real one.

| The live tower | Floors trade ranks |
|---|---|
| ![tower](docs/img/first-cut-tower.png) | ![rank swap](docs/img/first-cut-rank-swap.png) |
| **A floor** | **At a table** |
| ![floor](docs/img/first-cut-floor.jpg) | ![table](docs/img/first-cut-closeup.png) |

## Run it locally

You need:
- Node 24+
- Python 3.10–3.13, with `pip install -r apps/voice-worker/requirements.txt`
- a WebGPU browser (Chrome, Edge, or Safari 26+)

```sh
scripts/dev.sh                 # live HN + voice worker + the client
open http://127.0.0.1:5288
```

**Voices.** The default is Kokoro on one CPU thread. It's free, and every HN user gets a unique, permanent blend of two built-in voices.
- Kokoro runs a little slower than real time. So the best tables on the top floors are pre-voiced in the background, and any table you sit at jumps the queue.
- For character-actor delivery: `TTS_ENGINE=openai OPENAI_API_KEY=sk-... scripts/dev.sh`. That uses gpt-4o-mini-tts, with a persistent persona per person plus the comment's emotion. Spend is capped by `OPENAI_BUDGET_MIN` (default 300 minutes ≈ $4.50).
- Speech runs at 1.12× (`PACE`), with brisk turn-taking.
- Every comment is tagged for emotion, stance, intensity and cues (question, joke, sarcasm, insult, praise, uncertain, story…) by Claude Haiku. The tagger takes any Anthropic-compatible endpoint (`AUTH2API_URL`, key in `AUTH2API_KEY`), then falls back to `GEMINI_API_KEY`, then to a heuristic.
- Bumping `VOICE_VERSION` re-voices everything in the background. The old audio keeps playing until each replacement lands.

## Using it

- **Tower.** Drag to orbit, and hover a floor to see its story. Click to ride the elevator up.
  - Floors slide when stories trade ranks.
  - Windows flash when a comment lands.
  - The beacon pulses for every new comment on the front page.
- **Floor.** Pick a table (▶ means it's voiced), or the bar, where the one-off remarks are.
- **Table.** Space pauses, N moves to the next table, Esc stands you up, M mutes.
  - Links are held up as placards you can click.
  - When someone quotes the comment they're answering, its author speaks the quote.
- **Lean back:** top right on the tower. It rides to the liveliest floor, plays its best tables one after another, then moves down the ranking, hands-free.
- **Deep link:** `?story=<id>&table=<root comment id>`. The address bar updates as you sit down. Add `&from=<comment id>` to hear the opener, then jump straight to that reply.

## The acting

The tags drive the performance, and nothing is canned:
- **Turning to people.** Whoever replies turns to the person they're answering: shoulders part of the way, head the rest, eyes ahead of the head. Listeners watch the speaker, and everyone's eye-line tilts up to someone standing.
- **Standing up.** A heated reply (angry, or a strong disagreement) starts before the other person has finished. The speaker leans over the table, pushes off it (a thump on the wood, and the lens feels it), the chair scrapes back, and they stand and glare down at whoever they're answering. The room turns to look.
- **Gestures by tone.**
  - A pointed finger for pushback.
  - Open palms for questions.
  - A shrug, and looking up to find the words, when unsure.
  - Arms up when excited, a facepalm when frustrated, hand to chin when thinking.
  - An eye-roll on sarcasm.
  - A laugh at the end of a joke, which spreads round the table.
- **Listeners.**
  - The person being told off is taken aback.
  - The table gasps at an insult.
  - Whoever is praised lights up, hand to chest.
  - Someone about to disagree narrows their eyes and shakes their head.
- **Timing.** Heated replies cut in, a joke gets room for its laugh, and an answer to a question comes quickly.
- **The camera.** A small virtual cinematographer models everyone as capsules and won't shoot through a head. It keeps faces visible and changes angle and size on long comments. Its shots:
  - a rise shot, then a hero angle looking up at the one standing, over the shoulder of the one being told off
  - a reverse looking down at them
  - reaction cutaways to whoever is being answered
- **Long threads.** A table seats 8 and fits 8 more standing. Whoever is about to speak takes the place of someone who isn't due to.

## Layout

```
packages/core       speakability, play order, seats, permanent voices, live state (14 tests: `node --test packages/core/src/*.test.ts`)
apps/towerd         local stand-in for the edge + CDN: follows live HN, writes head/epoch/floor files, queues voicing
apps/voice-worker   tags, voices (Kokoro or OpenAI), writes clips + sidecars with loudness and mouth-shape tracks
apps/client         the 3D client: three.js on WebGPU, plain TypeScript
spikes/ research/   the first night's experiments and evidence
docs/PLAN.md        the plan; docs/img has the demos
```

## Vibe-testing the director

The client renders headlessly on a software GPU (`?record` makes time deterministic):
- `tools/sheet.cjs` grabs a frame every few seconds, with the camera's choice and the subtitle. `tools/tile.py` tiles them into one contact sheet.
- `tools/plan.py` draws top-down plans of a table: who sits where, who stands, where the lens is.
- `tools/record.cjs` and `tools/mux.py` make videos with the real voices and the synthesized chair scrapes and thumps.
- `?force=angry|joke|question|uncertain|excited|sad|list|sarcasm` makes every turn play that way.
- For takes that live HN can't rewrite mid-shot:
  - `?freeze` ignores table updates while seated.
  - `?skip=<id>,<id>` leaves comments out.

## Production

It runs on the homelab (`homelab.setup/kubernetes/apps/towerofhan`) as one pod with two containers sharing `/data`:
- `towerofhan-web` (towerd, which also serves the built client)
- `towerofhan-voice` (Kokoro, on one CPU thread)

Both images are private, in GHCR. `docs/DEPLOY.md` covers the costs and the reasoning.

- **Release.** Push an annotated tag `vX.Y.Z` on its own; CI builds and pushes both images at that version. Then bump both image tags in homelab.setup's `values.yaml` (tag AND digest), deploy that branch with `deploy-stuff.yml --ref`, check it, and merge.
- **Housekeeping is automatic.**
  - Deltas, old floor revisions and audio past `RETENTION_DAYS` are pruned.
  - Stories two days off the front page are forgotten.
  - A comment HN deletes or kills loses its audio.
- **Opt-out.** Add the HN username to `/data/optout.txt` (one per line; read every minute), or to `OPTOUT`. Their comments leave every table and their audio is deleted; replies to them still play.
- **Tagging.** Claude Haiku through the in-cluster auth2api by default; set `ANTHROPIC_API_KEY` to use the Anthropic API directly.
- **Health.** `/livez` is liveness. `/status` reports counts: items, voiced, queued, demand.

## Status

This is the first cut and runs locally only. Deployment follows `docs/PLAN.md` (Cloudflare R2 + CDN, one GPU box).
