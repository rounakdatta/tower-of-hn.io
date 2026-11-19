# TowerOfHan.io: the plan

*v1 · 19 Nov 2026 · branch `v2` · everything referenced here is in this repo*

**In one breath.** Hacker News's front page becomes a tower in a night city: one floor per story, ranked, sliding up and down live. Inside every floor, each thread is a table of characters who speak the comments verbatim, in their own voice and with their own face, as the conversation unfolds on HN. Tap a floor, sit at a table, listen. Lock your phone and it keeps playing like a radio.

## TL;DR

- **Proved last night on live data:**
  - the whole loop: HN → table → an LLM picks each turn's emotion → Kitten-TTS 2, a distinct voice per person → a 3D tower where the speaker's mouth moves with their real audio
  - a demo video with sound: `docs/img/e2e.mp4`
  - tonight's #1 thread voiced end to end: `spikes/ear-test/site/index.html`
- **The one architectural idea:**
  - Make every expensive thing **once per comment**, store it immutable, and let Cloudflare's cache hand it to everyone.
  - HN makes ≈10.5k comments a day; that is our whole workload, whatever the audience.
  - Viewers only read cached files, so 100k people cost the backend what one does.
- **Cost:** ≈ **$260/month, flat from 1k to 100k concurrent viewers**:
  - one GPU box: $235
  - Cloudflare: $5
  - the emotion-tagging LLM: ≈$9–18
  
  A CPU-only variant runs about $100/month, with slower voicing.
- **Stack:**
  - **TypeScript** for the client (three.js on WebGPU, with WebGL2 fallback) and for the edge (Cloudflare Workers + one Durable Object)
  - **Python** only inside the GPU voice worker
- **Voice:** Kitten-TTS 2 (1.7B) leads:
  - natural, with 115 voices plus cloning
  - emotion tags and emphasis
  - ≈24× realtime on a GPU
  - free until $1M revenue or funding
  
  The Apache-2.0 models are the fallback.
- **Timeline:** six milestones, each one something you can judge on your phone, then **Show HN on Tue 22 Dec**, "a Christmas gift to HN".
- **I need five decisions from you** (§13). None blocks today's work.

---

## 1. The experience

**Arrive.** You open towerofhan.io and the tower is already on screen. It isn't a spinner: it's tonight's tower with the real titles, rendered a minute ago on our GPU and served from the nearest Cloudflare city. Within a second or two it comes alive:
- windows flicker with real comment activity
- the roof beacon pulses whenever a comment lands anywhere on the front page
- the city hums

**The tower.** Thirty floors, one per front-page story, in rank order. Facades carry titles in light; lit windows are people talking now. When a story climbs, its floor slides up and the others step down, with a low mechanical rumble: the Tower of Hanoi made literal. That happens ~2.5 times every 30 s in the US evening. New stories are craned in at the bottom. Tap a floor and the glass elevator takes you up.

**A floor.** A warm room. Real conversations get round tables, big arguments big tables, and the heated ones draw a standing crowd. One-off remarks (most top-level comments get no reply) happen at the bar. The room murmurs, and the murmur is real: a pre-mixed loop of the other tables' actual conversations, quiet and placed in space.

**A table.** Sit, and it plays.
- **People:** every person has one face and one voice, everywhere in the tower. The speaker's lips follow the words. Listeners turn to look, nod, raise a brow at a snarky line, laugh at a joke. The person about to disagree is already narrowing their eyes: we know, because we know their reply.
- **Text on screen:** links are held up as placards you can tap. Code is chalked onto the table. Subtitles follow word by word.
- **Quotes:** when someone quotes the person they're answering, which 6% of comments do, you hear that line again **in its owner's own voice**.
- **Camera:** it directs itself like a good TV debate: wide to establish, singles on the speaker, over the shoulder for a direct reply, a cutaway to a reaction.

**Live.** Someone replies on HN while you're seated: a character walks up, takes a chair, and the reply joins the conversation about half a minute after it was posted. That half-minute is HN's own API delay, not ours.

**Pocket mode.** Lock the phone and the tower becomes a radio: this table, then the floor, then the next floor, with lock-screen controls.

**Share.** `towerofhan.io/t/<comment>` drops a friend at that table at that moment. The link unfurls with a picture of the scene, rendered once.

**Your own seat (later).** An HN user can claim their character by putting a code in their HN profile. They can then choose their voice and look, or opt out to a silhouette with text.

**Christmas.** Snow settles on the tower, which sits in a snow globe on the landing page. Donations keep the lights on, literally.

## 2. Five principles

1. **Build once, serve forever.** The voice, the lip, face and gesture tracks, and the share images are all made once per comment, stored immutable, and replayed from the CDN. Costs follow HN's volume, never the audience.
2. **A viewer costs nothing.** Clients only read cached static files: no per-viewer servers, sockets or queries.
3. **Latency is designed, not hoped for.**
   - Every hop has a budget (§4.4).
   - First paint has live data in it.
   - The next turn is downloaded and decoded before you need it.
   - The audio clock drives everything on screen.
4. **Words are sacred.** What people wrote is voiced verbatim and attributed, linked back to HN. AI shapes delivery (voice, face, gesture), never content. Deletions vanish within a minute, and opting out is free.
5. **Taste is a feature, and performance is part of taste.** A confident stylised world beats a fake-realistic one. Motion and sound carry the premium feel. A dropped frame is a design bug.

## 3. What we measured last night

All scripts are in `spikes/`. These are measurements, not assumptions.

| HN, the firehose | |
|---|---|
| Comments per day (last 7 days, Algolia) | **10,474 mean**, 12,925 peak weekday, ~8k at weekends; ≈55 h of speech/day |
| Comments per minute (99-minute live probe, US afternoon/evening) | **10.7**, mean 289 chars, median 181 |
| Delay from posting until HN's own API shows it | p50 **17.5 s**, p90 **31 s**. HN publishes in ~34 s batches, so a faster stream buys nothing. |
| Rank changes in the top 30 | **2.5 floors per 30 s**; ~10 new stories enter per hour |
| Dead or deleted on arrival | 7% |
| Share of comments on the current top 30 | 59% (and 89% land on stories with ≥50 points) |
| Shape of a floor (live front page) | median 10 tables. Median table = **one comment (~20 s)**; p90 2.6 min; the largest was 25 min with 54 people. The whole front page ≈ 7.7 h of speech. |

Across 1,471 front-page comments:
- **6.2% quote their parent** (so voice replay matters)
- 9.2% link
- 4.8% use italics for emphasis
- 0.4% contain a code block

| Voices (same five-comment thread, three people) | How it ran | Speed |
|---|---|---|
| **Kitten-TTS 2, 1.7B, emotion tags on** | KittenML's public demo GPU | **~24× realtime** |
| Gemini 2.5 Flash TTS (tone prompted) | Google API | ~2× incl. network |
| Kitten-TTS 2 nano (17M) | our CPU, 2 threads | ~2.7× |
| Kokoro 82M / Kitten-TTS 2 mini (82M) | our CPU, 2 threads | ~1.1–1.2× |

Qwen3-TTS, Chatterbox Turbo and Higgs Audio v2 didn't render: their free demo GPU quota ran out after three clips. They join the M0 bake-off.

| 3D (three.js r187 WebGPU, live data) | |
|---|---|
| Tower: 30 floors + a 520-building night city | **36 draw calls**, 15k triangles |
| A floor: up to 69 characters with shader-drawn faces and talking mouths | **8–9 draw calls**, 40–79k triangles |
| JavaScript | 232 KB gzipped, nearly all of it three.js |

## 4. Architecture

```
HN Firebase API ─► Orchestrator ─► jobs ─► Voice worker (1 GPU) ─► R2 ─► Cloudflare CDN ─► every client
(maxitem, updates,   Durable Object:            TTS → word/phoneme timing →        immutable files    reads only cached files;
 topstories)         state, play order,         face/gesture/reaction tracks →     + a 2 s head.json  no per-viewer server work
                     seats, voices, manifests   AAC clips + sidecar JSON
```

### 4.1 What is built once, and kept

| Artifact | Made when | Size | Cache |
|---|---|---|---|
| **Comment sidecar** `c/<id>.<rev>.json`: speakable text, tags, word timings, mouth/face/gesture/gaze/reaction tracks, clip list | a comment appears or is edited | ~3–5 KB | forever |
| **Clips** `c/<id>.<rev>.<k>.aac`: AAC-LC mono 24 kHz, ≤10 s each, cut at sentence ends from one continuous synthesis | same | ~4 KB/s | forever |
| **Floor snapshot** `f/<story>/<rev>.json`: tables, play order, seats, voices | first sight, then every ~30 new turns | ~3 KB brotli | forever |
| **Epoch delta** `e/<n>.json`: what changed in the last 2 s | when anything changed | ~1 KB | forever |
| **Head** `head.json`: epoch, tower order, latest floor revs | every 2 s | **828 B** (measured) | 2 s TTL + stale-while-revalidate |
| **Poster** `poster.avif`: the 3D first frame with live titles | every minute, on the GPU box | ~80 KB | 60 s |
| Floor murmur loop · share card | per floor every ~10 min · on first share | ~100 KB · ~60 KB | forever |

Why AAC rather than Opus: on iPhone, Opus decoding is unreliable before iOS 27, and Apple's streaming spec doesn't list it. AAC in ADTS clips plays everywhere. **The same clips feed both** the 3D scene (Web Audio) and the lock-screen radio (an HLS playlist, iOS's native background-audio path).

### 4.2 Live updates without paying per viewer
- **Clients** poll the 828-byte `head.json` every 2–3 s. The CDN collapses those requests, so R2 sees about one refill per TTL per region, whether 1k or 100k people are polling: **≈$1/month at any scale**. Clients then fetch the immutable epoch deltas they're missing.
- **WebSockets** (Durable Object fan-out) would save ~2 s and cost ≈$100/month at 100k viewers. That's an optional later add-on, as a "nudge" only.
- **Setup:** a Cache Rule makes `.json`/`.aac`/`.m3u8` cacheable. We verify short-TTL behaviour on day 1 (`research/data-infra.md` §2.2).

### 4.3 Play order, seats, voices: decided once, upstream
- **Play order:** depth-first in HN's ranked order, which is how people read.
- **Reply gaps:** 280 ms for a reply, 650 ms between siblings, 1.1 s when the thread steps back to an older branch.
- **Late replies:** they land mid-table with their position. The client plays them as a "late arrival" at the current speaker's next pause.
- **Seats:** the first eight speakers sit and the rest stand.
- **Voices: assigned the first time we ever see a person, then never changed.** Their audio depends on it. A test enforces this (`packages/core/src/live.test.ts`).

### 4.4 Latency budget: HN post → audible in the tower
| Hop | p50 | p95 |
|---|---|---|
| HN → its own API (outside our control) | 17 s | 33 s |
| Detect + fetch the item | 0.6 s | 3.3 s |
| Emotion tag (LLM, batched per HN tick) | 0.8 s | 2 s |
| TTS on GPU (a 17 s comment) | 1 s | 4 s |
| Timing, tracks, AAC encode, upload | 0.5 s | 1.5 s |
| head.json TTL + client poll | 2.5 s | 5 s |
| **Ours** | **≈6 s** | **≈17 s** |
| **Total** | **≈23 s** | ≈50 s |

**Instant when you tap:** the next 2–3 clips of your table (and the first clip of the best table on the floor you're looking at) are fetched *and decoded* in advance. Starting or switching plays from memory in well under 100 ms.

### 4.5 Edits, deletions, courtesy
- HN's `/updates` lists changed items.
- **Edited:** the comment gets a new revision and new clips.
- **Dead or deleted:** it's dropped in the next epoch (<1 min).
- **Our load on HN:** one poll of `maxitem` and `updates`, acting only when HN's ~34 s batch changes. Every item is fetched once. Last night's local orchestrator cut its refetches from ~1,400/min to ~110/min with exactly this rule.
- No viewer ever touches HN's API.
- dang announced on 31 Oct that he's building a new HN API, so ingest sits behind one adapter.

## 5. Voices

**Choice: Kitten-TTS 2 (1.7B), self-hosted on the GPU box, decided by a proper bake-off in M0.** Why it leads:
- **Quality:** it sounded the most natural of the engines that rendered (listen first).
- **Expression:** it takes `[emotion]` tags (10 emotions), vocal events (`<laugh>`, `<sigh>`, `<scoff>`) and `(((emphasis)))`.
- **Voices:** 115 built in, plus cloning from 5–30 s of audio.
- **Speed:** ~24× realtime, so one GPU voices all of HN at under a tenth of its capacity.
- **Licence:** a community licence. Commercial use is free after registration until $1M in revenue or funding; past that we negotiate, or re-voice with an Apache-2.0 model (packs are versioned).
- **Fallbacks, all Apache-2.0:** Kitten-TTS 2 mini/nano and Kokoro. The bake-off also tries Qwen3-TTS and Chatterbox Turbo on real hardware.

| How a comment becomes speech | Detail |
|---|---|
| **Identity** | Each person gets a voice the first time they appear, forever. The pool starts at 115 and grows by cloning *synthetic* reference voices (designed once per new voice), never a real person's voice. Claimed accounts choose their own. |
| **Speakability** | The words stay verbatim. Links become placards ("link: github.com" is the only spoken trace). Code goes on the table. HN italics become spoken emphasis. Typos are kept. Built and tested: `packages/core/src/speakable.ts`. |
| **Pronunciation lexicon** | Seeded from HN's own vocabulary: last night's survey found Quad9, http2, GPT-6.1, ICANN, KVM and others. An LLM proposes respellings, which are reviewed once and reused forever. A "that's not how you say it" button feeds it. |
| **Delivery** | One LLM call per HN batch tags each *sentence*: emotion, intensity, stance toward the parent, sarcasm, emphasis words. Those tags drive the voice's tags, the face and the gestures. Candidates: Claude Haiku 5.5 (≈$18/month, ≈$9 batched) vs. GPT-6 Luna vs. Qwen3.7-Flash, picked by a 300-comment hand-labelled eval. Sarcasm is the hard label. |
| **Quote replay** | A `>` quote that matches the parent is cut from the parent's own audio using its word timings, so it's replayed rather than re-synthesised. That costs nothing and happens in 6% of comments. |
| **Clips** | Each comment is synthesised whole, so the prosody flows, then cut into ≤10 s AAC clips at sentence ends using the word timings. |
| **Timing for lips** | Forced alignment on the GPU gives words and phonemes, and phonemes map to visemes. Phoneme-timed visemes are exact for synthetic speech, so no audio-to-face model is needed. |

## 6. Characters and emotion

**A kit, not a crowd of one-offs.**
- **Base:** one stylised seated-and-standing base body.
- **Parts:** modular heads, hair, hoodies and jackets, glasses, beards, hats.
- **Palettes:** designer palettes for skin, hair and clothes.
- **Assembly:** each person is assembled deterministically from a hash of their username. That's millions of combinations, and the same person looks the same on every floor.
- **Assets:** the base and parts are our own, with CC0 libraries (Quaternius, Kenney) as starting geometry and animation. We avoid assets whose licences forbid web use. AI 3D generation can rough out variations, cleaned up by hand.

**Faces are drawn by the shader, not modelled.** Last night's spike already does this: eyes, blinks and a talking mouth, computed per pixel from a few numbers, for every character in one draw call. v1 extends it to a few parameters per feature:
- eye shape, openness and gaze
- brow angle and curve
- mouth width, openness, roundness and smile curve
- cheeks, freckles, glasses

Emotion and speech are curves over those numbers. This reads at any distance, costs almost nothing, and can't fall into the uncanny valley, because nobody is pretending to be real.

**What the server precomputes per comment** (in the sidecar):
| Track | How |
|---|---|
| Mouth (open, wide, round) at 30 fps | phoneme timings → visemes → coarticulated curves |
| Face | per-sentence emotion → brow/eye/mouth targets with eased transitions |
| Body | beat gestures on emphasised and stressed words (word timings); iconic gestures from tags (shrug, point, count on fingers, dismissive wave, facepalm, arms crossed, lean in) |
| Gaze | the speaker addresses the person they're replying to, and glances at the room on long turns |
| Reactions | each listener's response to this turn: a nod if they later agree, narrowed eyes if they're about to object, a laugh at a joke |

**On the client:**
- **Bodies:** gestures and idles are a small library (~30 seated-conversation clips) baked into **vertex animation textures**. Every body on a floor is one instanced draw. Per-character clip, time and colour live in instance data.
- **Procedural layers in the shader:** head turns toward the speaker, breathing, blinking.
- **LOD:**
  - the table you're at gets full detail
  - the rest of the floor is instanced at a lower detail
  - distant floors show silhouettes in lit windows

## 7. Rendering and the client

**Engine: three.js r187, WebGPU renderer with automatic WebGL2 fallback, plain TypeScript, no UI framework.**
- **Why:** proven by the spike (36 draws for the whole live tower), node-based shaders (TSL) for the faces and the vertex-animation crowds, the largest ecosystem, and one renderer for both GPU APIs.
- **Its cost:** ~230 KB gzipped. A custom WebGPU renderer could be a fifth of that, but it isn't worth it before launch; we keep it as a post-launch option if profiling says so.

**Budgets on a mid-range phone:**
| | |
|---|---|
| Frame time | 16.6 ms at 60 fps, with dynamic resolution as the safety valve |
| Draw calls | ≤100 |
| Triangles | ≤300k |
| Texture memory | ≤128 MB |
| JavaScript | ≤300 KB, brotli |
| Initial download | ≤1.5 MB |
| Shader pipelines | all precompiled behind the poster |

**Boot:**
1. HTML with the tower's live state and the poster image arrives from the edge (first paint).
2. JS downloads.
3. WebGPU initialises and *every* material compiles while the poster is up.
4. The canvas crossfades in on the same composition.
5. Characters, interiors and sound stream in by predicted need.

**Four loops, so none can stall the others:**
- **Live sync** (worker): head and epochs.
- **Prefetch** (worker): a priority queue: your next three turns, then the best table on the floor you're looking at, then floors the camera drifts toward.
- **Audio:** sample-accurate scheduling, and the audio clock is the master clock, so lips, subtitles, gestures and cuts stay in sync even when frames drop.
- **Render** (main thread): per-frame JS only touches the people speaking or reacting.

**Audio on real phones:**
- **Decode fallbacks:** AAC decoding has had iPhone Safari bugs, fixed in 27.2. If decoding a clip fails, try again without its ID3 tag, then with WebCodecs (Safari 26+), then with a small WASM decoder.
- **Lock-screen radio:** native HLS playlists per floor or radio channel, built from the same clips. The playlist is a *selection*: HN produces 2.3 s of speech every second, so no stream can carry all of it.
- **First week:** test on your iPhone and a mid-range Android.

**Device tiers:** a 30-frame probe at boot picks one of four:
- **Ultra:** desktop WebGPU
- **High:** recent phones
- **Low:** 30 fps, fewer extras
- **Listen:** a 2D tower with audio

A phone that heats up drops a tier rather than frames.

## 8. Look and feel

GTA 6 has reset expectations. We can't out-real a $2B game in a browser tab, and shouldn't try. What wins on the web is a world that is unmistakably *designed*.

- **A · Night diorama** *(recommended)*:
  - the tower as a precious miniature at dusk: deep blue air, amber windows, soft glow
  - a gentle tilt-shift on the wide shot; at Christmas, a snow globe
  - soft vinyl-toy characters with drawn faces
  - warm, lamp-lit interiors in wood and felt
- **B · Running Rectangles** *(your 2023 name for this idea)*: pure geometry, minimal faces, flat pastel light, bold type. The cheapest to render and the least likely to age.
- **C · Paper theatre:** cut-out characters on 3D stages. Charming, but it reads less "3D".

**Recommendation: A, with B's discipline.**
- **Palette:** few colours. HN orange only where it means something: the beacon, the rank, the speaker's name.
- **Light and type:** baked light and ambient occlusion, one cheap bloom, MSDF text for crisp titles.
- **Motion:** critically damped springs.
- **Sound is half the premium:** spatial voices and room reverb, the city, the elevator, and the rumble when floors trade places.

M3 opens with three 20-second mood clips for you to choose from on your phone.

## 9. Stack and repository

| Where | What | Language |
|---|---|---|
| Phone / laptop | the 3D client | TypeScript + three.js |
| Cloudflare | HTML shell with live state; share cards; the orchestrator (one Durable Object); R2; CDN | TypeScript |
| One GPU box (Hetzner GEX45: RTX PRO 4000 Blackwell, 24 GB) | TTS, alignment, tracks, AAC, posters | Python (model serving only) |

- **Shared code:** one schema, one speakability layer and one play-order function, shared by edge and client, tested once.
- **Why not Rust everywhere:** our hot paths are GPU inference and the network. The per-frame CPU work is tiny by design. WASM stays a scalpel, for the AAC fallback and pitch-preserving 1.25× playback.

```
packages/core       speakability · play order · seats · voices · live state (12 tests, passing)
apps/orchestrator   floor.ts (manifest + jobs) · local.ts (live HN → head/epochs/snapshots, runs today)
apps/voice-worker   voice.py (tags + Kitten-TTS 2 + loudness track; production adds alignment + AAC clips)
apps/client         (M1) the real client, grown from spikes/tower3d
apps/edge           (M1) Worker + Durable Object
spikes/             firehose probe · ear test · tower3d · e2e recorder · speakability survey
research/           data-infra.md (+ cost_model.py): the evidence behind §4 and §10
```

The 28 Mar code (Go, Postgres, Next.js, ComicGen) stays in git history.

## 10. Costs (USD/month)

| | 1k viewers | 10k | 100k concurrent |
|---|---|---|---|
| GPU box (Hetzner GEX45, flat; €209 one-off setup) | 235 | 235 | 235 |
| Emotion tagging (Haiku 5.5 list; ≈half with Batches) | 18 | 18 | 18 |
| Cloudflare: Workers paid plan, R2 storage and operations | ~9 | ~9 | ~34 |
| Live updates (polling a cached `head.json`) | 1 | 1 | 1 |
| **Total** | **≈263** | **≈263** | **≈288** |

- **What scales:** the GPU stays flat until HN is 10–40× bigger, and tagging doubles only if HN's volume does.
- **Egress:** R2 egress is free; on a typical CDN, 100k sustained listeners would be ~$3.8k/month. Cloudflare's terms want media served from R2, which we do. We talk to them before sustained 100k.
- **Alternatives:**
  - **CPU-only:** ≈$101/month, with TTS 4–11 s slower and thin burst headroom.
  - **Serverless GPU:** ≈$600/month, because HN's 34 s rhythm keeps it warm all day. It's for backfill only: a month of history ≈ $62, one-off.

## 11. Roadmap to Christmas

| Milestone | Target | You'll be able to... |
|---|---|---|
| **M0 · Decide** | Fri 20 Nov | pick the voice (bake-off page), the look, and the budget; buy the domain |
| **M1 · The tower is alive** | Tue 24 Nov | open a private URL and watch tonight's front page as a live tower: real titles and activity, floors sliding on rank changes |
| **M2 · Tables speak** | Sun 29 Nov | sit at any table on the top 10 floors and hear it, with lips in sync, subtitles, lock-screen radio, and first word in <300 ms |
| **M3 · People, not puppets** | Sun 6 Dec | see distinct, consistent characters who emote and react; a camera that directs itself |
| **M4 · Art and sound** | Sun 13 Dec | feel the difference between a demo and a place; 60 fps on your phone and a mid-range Android |
| **M5 · Launch-proof** | Fri 18 Dec | trust it under a front-page spike: 100k-viewer load test, cost guards, deletion and opt-out paths, share cards, nightwatch checks, a courtesy note to HN's moderators |
| **Launch** | **Tue 22 Dec** | post Show HN |

**Out of v1, on purpose:**
- chat or presence beyond a viewer count
- posting to HN (HN's rules forbid automated and AI-edited posts)
- paid anything
- other sources (Reddit, Lobsters: the source adapter keeps that door open)
- native apps

**This week, while you travel (M0–M1), I'll do:**
- the GPU bake-off on 200 real comments
- the 300-comment tagging eval
- the Cloudflare canary (TTL, request collapsing, AAC on your iPhone)
- the client v1 on the live data plane

## 12. Risks

| Risk | What we do |
|---|---|
| Voices don't reach "awe" | Pick by ear first. Per-sentence emotion. HN's own italics as emphasis. A lexicon mined from HN. Re-voice anything when models improve (packs are versioned). |
| Portraying real people badly | Stylised, never realistic. Voices are synthetic, labelled, and never cloned from real people. Claim-or-opt-out for every HN user. |
| HN/YC objects | Precedent: HackerFM (2023, 351 points) and The HN Recap drew no moderator objection, and dang says the API data is free to use. Every line links back. Deletions are honoured fast. No automated posting. A courtesy note before launch. |
| Phones choke | Device tiers, dynamic resolution, WebGL2 fallback, a 2D "listen" tier, weekly tests on real phones, budgets in CI. |
| Kitten-TTS 2's licence (free < $1M revenue/funding, revocable) | Register for commercial use. The Apache-2.0 fallbacks are tested in the bake-off. Packs record which model made them. |
| A free tier vanishes | Production depends on no free tier. Last night's demos were for experiments only. |
| Christmas slips | Scope locked; each milestone ships on its own. M2 alone is already a lovely audio-first tower. |
| One maintainer, agent-written code | Tested core, a review agent on every diff before deploy, budgets in CI; the plan and decisions live in the repo. |

## 13. Decisions I need from you

1. **The voice.** Listen to `spikes/ear-test/site/index.html`: tonight's #1 table first, then five engines. Kitten-TTS 2 is my pick unless your ear says otherwise.
2. **The look.** A (night diorama), B (Running Rectangles) or C (paper theatre). My pick is A with B's discipline. Mood clips come in M3, but a gut call now steers M1.
3. **Budget.** Is ≈$260/month to start OK, with the GPU box at €214/month + €209 setup in your Hetzner account? The alternative is the ≈$100/month CPU box until launch.
4. **Accounts, which only you can do:**
   - buy **towerofhan.io** (and .com, both looked unregistered last night)
   - a Cloudflare R2 bucket + the Workers paid plan ($5)
   - register with KittenML for commercial use
   - an Anthropic API key for tagging, if Haiku wins the eval
5. **Open source at launch?** I'd say yes: HN trusts what it can read, and it invites donations and contributors.

---

### Appendix: where everything is
- `docs/img/e2e.mp4`: the whole loop with sound, 107 s
- `docs/img/spike0-tower.png`, `spike0-floor.png`, `spike0.mp4`: the first spike
- `spikes/ear-test/site/index.html`: the listening page
- `research/data-infra.md`: HN API behaviour, Cloudflare pricing and limits, audio formats on iPhone, GPU and LLM prices, the cost model (all sources dated 19 Nov 2026)
- `packages/core`: run `npm test` (12 tests)
- `apps/orchestrator/src/local.ts`: run `node src/local.ts out 10` to watch live HN become head/epoch/snapshot files
- **Not yet researched in depth** (the agents were cut off by a spend limit at 2 AM): a 2026 survey of web 3D engines, character asset licences, and the newest open TTS models. §5–7 rest on last night's spikes and established technique. M0 closes those gaps with measurements, not reading.
