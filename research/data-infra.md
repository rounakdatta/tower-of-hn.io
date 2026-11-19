# TowerOfHan.io: data plane, delivery and cost model

Research date: 19 Nov 2026 (IST; live probes ran 18 Nov from 19:34 UTC for about 1.5 hours). Everything price- or limit-shaped was read on a live first-party page that day unless tagged otherwise. Source IDs in square brackets resolve to the table in Appendix A, with the URL and the date read.

Confidence tags: **verified** = read on the first-party page or measured by me; **secondary** = third-party page; **UNVERIFIED** = inferred, a single anecdote, or not checkable from this box. Nothing is guessed silently.

Companion file: `cost_model.py` (same folder). It holds every unit price and reproduces the tables in section 6 (`python3 -I cost_model.py --gpu-hours-day 5 --hours-day 24`).

---

## 0. Summary

**Recommendation in one line:** ingest and process on one Hetzner GEX45 (Kokoro on its GPU, a $5 to $18/month tagging LLM), write immutable AAC clips and a 2-second `head.json` to R2, serve everything through Cloudflare's cache with no Worker on the read path. About **$262/month** fixed (+$229 setup), **$263 / $263 / $288** at 1k / 10k / 100k sustained viewers; viewers cost about $0.0018 per 1,000 viewer-hours even with an optional $103 WebSocket nudge.

| Question | Answer | Where |
|---|---|---|
| How fast can a comment reach us? | HN's Firebase feed is a **34 s batch tick** (`maxitem`, `topstories`, `updates` move together). Creation-to-visible: mean 18.2 s, p90 31.9 s, max 37.1 s (849 items over 62 minutes). SSE is no faster than 0.5 s polling. Algolia is slower (items API median 31 s, search index median 108 s). The 34 s floor is upstream of anything we control; our own hops fit in about 6 s median. | 1.1, 1.3, 7.2 |
| Volume | 2026: 11,283 comments/day incl. dead/deleted, 10,511 live; weekdays 11.2 to 11.7k, weekends 8.3k, max day 14.8k; peak hour about 670, worst minute 37, worst 5 minutes 153. Mean comment 308 chars. 89% of comments are on stories with at least 50 points (67/day), so filtering to the front page saves little. About 6% arrive dead, 2.7% deleted. | 1.5 |
| Spoken audio | 12,000 x 250 chars = **55.6 h/day**; 25 GB/month of new media at 32 kbps AAC; R2 cost $0.23 rising to $4.36 after a year. | 1.5, 6 |
| Rate limits, terms | Firebase: "no rate limit". HTML crawl-delay 30 s. Algolia: 10,000 requests/hour/IP. YC ToU grants no license to republish comments and bars scraping "except as expressly authorized"; the API is the sanctioned channel. No moderator objection in any prior-art thread (HackerFM, HN Recap, HN Watercooler, HackerTube). **Dang (31 Oct 2026) is building a first-party JSON API**, so hide ingest behind an interface. | 1.1, 1.6 |
| Cloudflare path | R2 custom domain + Cache Rule + Smart Tiered Cache; immutable clips, 2 s `head.json` (`stale-while-revalidate`). No per-GB or per-request CDN meter; R2 egress free; request collapsing per data center. Live updates cost about $1/month by polling at any viewer count; DO WebSocket hibernation nudge $0.23 / $6.94 / $102.79 at 1k / 10k / 100k sustained; SSE about 1.8x that; Ably/Pusher scale with viewers (Pusher's top plan is 30k connections). **PartyKit hosted shut down 23 Oct 2026. Workers AI MeloTTS is "Planned Deprecation 11/20/2026".** Containers have no GPU. | 2 |
| Egress | 10.9 / 109 / 1,089 TB per month at 1k / 10k / 100k sustained viewers (32 kbps) = $0 on R2+CDN, about $54 / $544 / $4,677 on Bunny's cheapest tier. The Cloudflare ToS requires audio to be served from Developer Platform storage (R2): satisfied, but at 100k talk to Cloudflare first. | 2.2, 6.3 |
| Audio format | **Safari 27 shipped 14 Sep 2026**; 27.0 fixed Opus-in-MP4 `decodeAudioData`, 27.2 fixed `EncodingError` on valid AAC/M4A. Apple's HLS spec never mentions Opus. Best single file set: **AAC-LC mono 24 kHz, 32 kbps, ADTS with an ID3 PRIV timestamp, clips of at most 10 s**, one live playlist per radio channel with a discontinuity per clip. Unproven on a device; eight iPhone tests listed. | 3 |
| TTS compute | Kokoro: CPU RTF 0.64 on 4 vCPU (1.6x), GPU RTF 0.01 to 0.06; HN arrives in 34 s bursts so serverless containers stay warm 24 h/day (**$575/month for an L4** vs **$235 for a GEX45**). Cheapest: a flat-rate always-on box; CPU-only on an AX42 is $87 with +3 to 10 s latency. Serverless only for backfill (about $62 per month of history). Curves come free from Kokoro's `pred_dur`. | 4 |
| Tagging LLM | 108 M in + 14.4 M out tokens/month. **Haiku 5.5 and GPT-6 Luna $0.10/$0.50: $18.00** (about $13 with a padded cached prefix); Qwen3.7-Flash $5.11; Gemini 2.5 Flash-Lite (today's prototype) $16.56; Haiku 4.5 $180. Self-hosting is not worth it. GPT-5 nano/mini shut down 11 Dec 2026. Evaluate on 300 hand-labelled comments first. | 5 |
| Monthly total | D1 lean CPU $101 to $127; **D2 recommended $262 to $288**; D3 serverless real time $603 to $628; D4 managed TTS $1,377 to $1,403. Add up to $103 for the WebSocket nudge at 100k, or $200 to $250 if Cloudflare requires the Business plan. | 6.4 |

Where the brief's assumptions are out of date (all verified on 19 Nov 2026): **Safari 27 shipped 14 Sep 2026** (not 26); Hetzner's **GEX44 and GEX130 are retired** (GEX45 EUR 214, GEX131 EUR 1,499); **Claude Haiku 4.5 is superseded by Haiku 5.5** at one tenth of the price ($0.10/$0.50) and **GPT-5 nano/mini shut down 11 Dec 2026** (GPT-6 Luna replaces them); **PartyKit's hosted platform closed 23 Oct 2026**; **Ably now prices by monthly active users** ($1,149/month at 50k MAU, custom above); **Workers AI MeloTTS is scheduled for deprecation 20 Nov 2026**; Cloudflare Containers still has no GPU; the HN Firebase README is unchanged since Jan 2025 but a first-party JSON API is being built.

Not settled (all tagged UNVERIFIED in the text): whether a Free zone honors a 2 s origin `max-age` on R2, R2 billing of edge cache hits, Cloudflare's tolerance for 33k rps and 1 PB/month, DO sockets per shard, TTS quality and speed on the actual GPU, cheap-LLM sarcasm accuracy, every iPhone behaviour in section 3.8, BigQuery freshness. Section 8 lists them with the experiment that settles each.

---

## 1. HN data plane

### 1.1 Official Firebase API ([H1])

| Item | Finding | Confidence |
|---|---|---|
| Base and endpoints | `https://hacker-news.firebaseio.com/v0/`: `item/<id>`, `maxitem`, `topstories` and `newstories` (up to 500 ids, `topstories` also contains jobs), `beststories`, `askstories`/`showstories`/`jobstories` (up to 200), `updates` (`{items:[...], profiles:[...]}`), `user/<id>`. `kids` is in ranked display order. | verified [H1] |
| Rate limit | README: "There is currently no rate limit." README unchanged since the repo's last push on 2025-01-01 (GitHub API `pushed_at`). Contact: api@ycombinator.com. | verified [H1] |
| Courtesy guidance | For the HTML site, `robots.txt` says `Crawl-delay: 30` [H2]. Dang: "If you're scraping HN, please wait 30 seconds ... our app server still runs on a single core ... If you need to check more frequently, https://github.com/HackerNews/API works fine" (13 Jan 2022) [H9]. In 2015 aggressive crawling forced HN to switch off old articles [H15]. Net: the API is the sanctioned high-frequency path; keep the request rate modest (we need about 14 GETs/min plus one SSE stream). | verified |
| SSE | `curl -N -H 'Accept: text/event-stream' <url>.json` works on every path. Events: `put` with `{"path":"/","data":...}` and `keep-alive` every about 30 s. `maxitem` put = an integer (28 B). `topstories` put = the full 500-id array every time (4.5 KB). `updates` put = the whole object (about 80 item ids, about 30 profile names, 1.0 to 1.2 KB), a rolling window about one to two ticks deep. Per-item streams (`item/<id>.json` on a front-page story) push the whole item on the same tick (32.5 s intervals, 0.9 to 1.1 KB per push); `newstories` and `showstories` push the full list only when it changes (no change in an 80 s window). | measured [H16] |
| Cadence | All three streams fire together every **34 s** (24 full intervals over three runs: 32.8 to 36.0 s on SSE, 31.9 to 36.2 s on REST polling). One batch carries about 9 new item ids (6 to 14). | measured [H16] |
| SSE vs polling | `maxitem.json` polled every 0.5 s saw each new value within 0.6 s of the SSE event (6 of 6; REST was never later). SSE saves requests, not latency. | measured [H16] |
| Creation to visible | 849 items over 62 minutes, other probe (`spikes/firehose`, read-only, still running when read): min 0.0, p10 4.6, **median 18.0, mean 18.2, p90 31.9, p99 36.1, max 37.1 s** (includes retries). My 60-item run: median 11.2, mean 13.1, p90 27.0, max 32.8 s. 59 of 60 items first became fetchable at the tick that moved `maxitem`. | measured [H16] |
| Lag vs the website | The logged-out HTML (`/newcomments`, `Cache-Control: private; max-age=0`) is served from a snapshot that changed only about every 2 minutes in 11 fetches (newest comment 16 to 111 s old at fetch time, while Firebase already had newer items), so Firebase (mean 18 s) is fresher than the logged-out site. Logged-in HTML freshness not measured; scraping it is barred by the ToU anyway. | measured, weak [H16] |
| Body lands after the id | At the SSE event, 12 of 13 first `item/<id>` GETs returned `null`; bodies landed within 1 to 3 attempts (1 s, 2 s backoff). Other probe: per-item fetch incl. retries median 0.53 s, p90 3.4 s, p99 5.6 s, max 6.0 s. Retry with backoff; `null` is normal for a few seconds. | measured [H16] |
| Payload | Item JSON median 246 B, mean 357 B, p99 1.7 KB. GET about 0.5 s from this box (TLS included). `Cache-Control: no-cache`. | measured |
| `/v2`, `/v1` | Return 401 "Permission denied" (a Hugging Face dataset card cites `/v2`; it does not exist). | measured |

**What this means for latency.** The feed is batchy by design: a viewer cannot see a comment sooner than the next tick. Budget upstream as mean 18 s, p90 32 s, max about 37 s, and spend our own effort on the remaining hops (section 7).

**Front page is slow-moving.** From the other probe's 63 minutes of 30-second snapshots (126): 9 stories entered the top 30 (about 8.6/h, boundary re-entries included), 25 of 30 were the same first vs last, 92% of top-30 ranks unchanged between snapshots, mean absolute rank change 0.11 per snapshot. Floors are nearly static; cache per-floor data aggressively.

### 1.2 How changes surface (edits, deletions, dead/flagged, moves)

The API has no revision field and no edit timestamp ([H1] field table). Everything is "the item id reappears in `updates`", then you re-fetch and diff.

| Event | What you see | Evidence |
|---|---|---|
| New item | Id above the previous `maxitem`, body lands 0 to 3 s after the id. | measured |
| Edit | Same id in `updates`; `text` or `title` differs. No flag. Hash the text to detect. Edits are rare next to reply-driven updates: of 27 comments older than 2 h that sat in one `updates` snapshot, 0 had text different from Algolia's copy and 5 had one more `kids` entry (a fresh reply). One snapshot of 83 ids held 12 brand-new items, 20 comments from the last hour, 23 older comments and 28 older stories (score/`descendants` moves). The length of the edit window is not stated in the FAQ (UNVERIFIED). | [H1], [H8], [H16] |
| Deleted | `deleted: true`; `text`/`by` gone. FAQ: "The author deleted the post, or asked us to. Unlike dead posts, these remain deleted even when showdead is turned on." Share of comment rows: 2.7% in Oct 2026 (9,766 of 359,658; ClickHouse records deleted rows only since Dec 2025). | verified [H8], [H4] |
| Dead / flagged | `dead: true`, text still present. FAQ: killed "by software, user flags, or moderators"; shown only with `showdead`. The API does not distinguish flagged vs software-killed vs shadow-banned. Dang (2 Oct 2026): "When a post gets a lot of flags relative to upvotes, HN's software kills the post ... Moderators sometimes also kill posts, but mostly they're killed by software." Share: 5.9% of comment rows in Oct 2026 (21,203 of 359,658); 54 of 849 items (6.4%) in the live sample were `dead` at first sight. Posts by flagged/new accounts are dead on arrival and can be revived by vouching, so `dead` can flip back. | verified [H8], [H15], [H4] |
| Moved / merged / detached | Moderators re-parent: "we've moved the comments to <other story>", "We merged the comments from <dup>", "We detached this subthread from <comment>" (dang/tomhow, Jul to Nov 2026) [H15]. Observed in the API: for a subthread detached on 13 Nov 2026, the root comment now has `parent` = the story id, `dead: true`, and is absent from the old parent's `kids`; Algolia returns 404 for it. **`parent` and `kids` are mutable**; never cache a thread's shape as final. | measured [H16], [H15] |
| Story rank | `topstories` order; changes arrive on the 34 s tick only. Rank-affecting moderator actions (penalties, title/URL edits) show up as item updates. | measured |

Design consequence: key stored media by `(comment id, sha1(text)[:8])`; on an `updates` hit whose hash changed, mint a new revision (old objects stay immutable), and on `deleted`/`dead` stop referencing the media and purge it by URL.

### 1.3 Algolia HN Search API ([H3], measured [H16], [H17])

| Item | Finding |
|---|---|
| Endpoints | `https://hn.algolia.com/api/v1/search` (relevance), `search_by_date`, `items/<id>` (the **full nested tree**, `children[]`), `users/<name>`. Filters: `tags` (`comment`, `story`, `author_x`, `story_<id>`), `numericFilters` (`created_at_i`, `points`), `hitsPerPage` (up to 1000), `page`. |
| Rate limit | "We are limiting the number of API requests from a single IP to 10,000 per hour." (first-party docs page, "Rate limits" section) [H3] |
| Items tree | 878-comment story: one request, 571 KB, 2.5 s. Ideal for seeding a floor (1 request per story) and for backfill. Dead comments return 404. |
| Index lag | `search_by_date` newest-comment age at poll: median 137 s. Per-comment first-seen lag from creation: n=40, min 33 s, **median 108 s, mean 129 s, p90 242 s, max 253 s** (5 s poll). `items/<id>` lag from creation: n=17, min 15 s, **median 31 s**, mean 33 s, max 64 s; 1 of 18 not served within 120 s. Algolia trails Firebase by a median of 96 s. Do not use Algolia for real-time. |
| Quirks | `nbHits` is **not exhaustive** on large windows (`exhaustiveNbHits:false`; a 1-week window reported 2.7M). Use 1-day windows (flag true; counts matched ClickHouse within 1%). A query returns at most 1,000 hits (page 1 empty at `hitsPerPage=1000`), so slice by `created_at_i` for backfill. No change feed. |

### 1.4 Bulk sources for backfill and statistics

| Source | Freshness | Notes |
|---|---|---|
| ClickHouse SQL playground, DB `hackernews`, tables `hackernews`, `hackernews_indexed`; `https://sql-clickhouse.clickhouse.com/?user=demo` (HTTP, no password) [H4] | **verified current**: `max(time)` = 2026-11-18 19:00:45 when queried at 19:38 and again at 19:57 UTC, so refreshed about hourly; 50.5M rows, max id 50,550,543 | Free and queryable with plain `curl`. Used for all volume figures here. Caveat: `score` and `descendants` of recent stories are snapshots from ingest (stale), so do not use them for popularity; use Algolia or Firebase. |
| BigQuery `bigquery-public-data.hacker_news.full` | **UNVERIFIED** (no GCP project here). Secondary: MotherDuck docs call their copy "refreshed daily from Google's public BigQuery copy ... which usually runs one to two days behind the live site" [H5]; a Jun 2024 "Tell HN" was titled "Hacker News BigQuery dataset is updated daily again" (a lapse happened) [H11] | Third-party dataset, not HN-run (dang, 2024: "entirely 3rd party") [H11]. |
| Hugging Face `open-index/hacker-news` (ODC-By, Parquet, 5-minute live blocks) [H6] | **stale**: card and repo metadata end 2026-08-23 16:00 UTC; seemingly stopped ~3 months ago (UNVERIFIED whether it moved) | Its pipeline backfills from ClickHouse and live-polls Firebase. |
| Algolia items/search | minutes (section 1.3) | Best for tree seeding. |

For historical backfill use ClickHouse (ids, parents, text) and Algolia `items/<story>` (trees). For live use Firebase only.

### 1.5 Real volumes, 2025 to 2026 (ClickHouse [H4], cross-checked with Algolia day counts)

Per-day averages (all comments include dead and deleted; "live" excludes them):

| Year | Comments/day, all | Comments/day, live | Stories/day, all | Stories/day, live |
|---|---|---|---|---|
| 2023 | 11,468 | 11,013 | 1,096 | 874 |
| 2024 | 9,125 | 8,894 | 1,074 | 834 |
| 2025 | 9,565 | 9,311 | 1,081 | 849 |
| 2026 (to 17 Nov) | **11,283** | **10,511** | 1,450 | 1,030 |

Monthly comments (all / live): 2025-07 288,628 / 281,378; 2025-08 304,032 / 297,250; 2025-09 311,317 / 302,561; 2025-10 310,773 / 303,390; 2025-11 290,451 / 283,382; 2025-12 312,199 / 303,871; 2026-01 351,195 / 336,403; 2026-03 343,625 / 321,966; 2026-06 345,992 / 320,826; 2026-09 355,556 / 328,701; **2026-10 359,658 / 330,010** (11.6k / 10.6k per day). Dead comments rose from about 7k/month (2025) to 21k/month (Oct 2026): 2.4% to 5.9% of comment rows.

Shape (live comments, 2026 days, n=321): mean 10,511, p10 7,953, p50 10,930, p90 12,344, p99 13,419, max 14,763. By weekday (Mon to Sun): 11,232 / 11,691 / 11,717 / 11,413 / 10,848 / **8,342 / 8,357**. By UTC hour (Aug to Oct 2026, comments/hour): trough 257 at 04:00, ramp from 11:00, **peak 665 to 670 at 15:00 to 16:00**, still 594 at 20:00. Per minute (Aug to Oct): p50 7, p90 13, p99 19, p99.9 23, **max 37** (0.62/s, 9 Sep 2026 18:35 UTC). Plan for a 10x burst over the mean rate in the worst minute, not 100x.

Text size, live comments Aug to Oct 2026 (n=975,658): plain-text mean **308 chars**, p50 195, p90 697, p99 1,882; 1.6% exceed 1,500 chars; 3.27M chars/day. The brief's 12,000 x 250 = 3.0M chars/day is within 9% of measured. Long comments need a cap policy (voice the first about 600 chars, or split).

Where the comments are (October 2026, Algolia per-day windows, 326,411 comments): stories with at least 10 points hold 95% of comments (139 stories/day); at least 20 points: 93% (99/day); at least 30: 92% (84/day); **at least 50: 89% (67/day)**; at least 100: 79% (44/day). Voice everything on stories at or above about 20 points: you only avoid about 7% of the work, and you gain a clean rule.

Derived: 12,000 comments/day x 250 chars = 3.0M chars = about 55.6 spoken hours/day at 15 chars/s (about 150 wpm). Averaged over 24 h that is 2.3 seconds of audio to produce per wall-clock second; in the worst minute (37 comments, about 617 s of audio) it is 10x real time.

### 1.6 Terms, prior art, moderator reactions

- **YC Terms of Use** [H7]: users keep ownership of their User Content and grant YC (not third parties) a perpetual license; visitors agree not to "modify, copy, frame, scrape ... or create derivative works based on the Site or the Site Content ... except as expressly authorized by Y Combinator" and not to use "data mining, robots, scraping or similar data gathering". The README's statement that YC is "making the public Hacker News data available in near real time" through Firebase is the only authorization we found; there is **no separate API terms document**. So the API is the right channel, but nothing grants a license to republish comments: voiced comments are third-party content. Mitigations that fit the product: always attribute (username, link to the HN item), honor deletes/dead immediately, publish a takedown address, use synthetic voices that are not tied to a real person, never clone voices per user. This is risk framing, not legal advice.
- **Posting back** (the planned speech-reply feature): there is no write API in [H1]. Guidelines: "Don't post generated text or AI-edited text", "please don't automate posting" [H8]. Transcribing the user's own dictation verbatim is human-authored; an LLM "clean-up" pass is not allowed; posting has to go through the user's own logged-in browser session.
- **Moderator posture**: dang, 12 Jun 2024 on third-party datasets: "so anyone is free to do this" [H11]; 13 Feb 2026 on a data question: "all available through both the HN Firebase API (which is a bit antiquated) and Algolia's HN Search API. If you find anything interesting, definitely let us know!" [H12]; tomhow, 13 Jul 2026: "the HN API is public and many people ingest and store everything that is posted" [H13]. **No moderator objection** appears in the threads of the closest prior art: HackerFM (Mar 2023, 351 pts; Azure TTS), The HN Recap (May 2023, 177 pts; ElevenLabs, about $1 compute per 10-minute episode; a commenter asked about commenter copyright, no reply from HN staff), HN Watercooler (Apr 2025, 51 pts, listen to threads as audio; ElevenLabs at $0.12 per 1k chars) [H14]. HackerTube (Karpathy, 31 Oct 2026, 2,895 pts) shows the 2026 appetite for HN-derived views [H14]. Cost data point: ElevenLabs at $0.12 to $0.30 per 1k chars would be $360 to $900 per day at our 3.0M chars/day, which is why open-weights TTS is the whole premise.
- **New API coming**: dang, 31 Oct 2026: "For years* I've wanted to replace that API with one we operate ourselves, which will simply return a JSON version of any HN URL. I've finally started working on this!" It must keep HTML pages and the API identical and will expose reply structure [H10]. No date. Keep the ingest adapter behind one interface (`nextBatch() -> items`) so a swap is a one-file change.

### 1.7 Ingest design that follows from the above

1. One long-lived SSE connection to `maxitem` (and `updates` for edits/deaths/moves), reconnect with backoff; poll `maxitem` every 5 s as a watchdog.
2. On each tick fetch ids `last+1..maxitem` (about 9 per tick) with retry/backoff for `null`.
3. Seed each front-page story's tree from Algolia `items/<story>` once, then apply Firebase deltas. Re-seed a floor when `updates` shows `parent`/`kids` surgery.
4. Skip `dead`/`deleted`; voice only live text; store `(id, rev, parent, story_id, by, time, text_hash)`.
5. Tolerate a 6% dead-on-arrival rate and 2.7% deletions without alarms.

---

## 2. Cloudflare: current prices, limits and the delivery path

### 2.1 Price and limit table (all read 19 Nov 2026)

| Product | Price and limit | Source |
|---|---|---|
| Workers Paid | $5/month minimum. Requests: 10 M included, then $0.30/M. CPU: 30 M ms included, then $0.02/M ms. No duration charge, no egress charge. Subrequests free. A WebSocket upgrade counts as one request; messages through a Worker are not requests. Static-asset requests free and unlimited. Free plan: 100k requests/day, 10 ms CPU per invocation. HTTP request wall time unlimited while the client is connected, but a runtime update gives existing connections up to 20 min, so clients must reconnect. | [C1], [C2] |
| **Workers Cache** (new, per-Worker cache) | Hits are billed at the normal request rate ($0.30/M beyond the allowance); zone Cache Rules do not apply to it. Never put it on a polled path. | [C22] |
| R2 | Standard $0.015/GB-month; Class A $4.50/M; Class B $0.36/M; free 10 GB, 1 M A, 10 M B per month; **egress free**. Infrequent Access $0.01/GB-month, A $9.00/M, B $0.90/M, retrieval $0.01/GB, 30-day minimum. Limits: 1 write per second per key (429 above); `r2.dev` is rate limited (hundreds of rps) and has no cache, WAF or Access, so production needs a custom domain; object up to 4.995 TiB. | [C3], [C4], [C5] |
| Durable Objects (SQLite) | Requests $0.15/M after 1 M included. Duration $12.50/M GB-s after 400k GB-s included; 128 MB is billed per active object regardless of use; **idle objects that can hibernate are not billed**. WebSockets: connecting = 1 request; incoming messages count 20:1 (100 messages = 5 requests); **outgoing messages free**; protocol pings free; `setWebSocketAutoResponse` replies cost no time. SQLite storage billing from Jan 2026: rows read $0.001/M after 25 B, rows written $1.00/M after 50 M, stored $0.20/GB-month after 5 GB. Limits: soft 1,000 requests/s per object, single-threaded; docs say a DO can "connect thousands of clients per instance" (a 32,768-socket cap appears only on unofficial copies: UNVERIFIED). | [C13], [C14], [C15] |
| Queues | $0.40/M operations after 1 M; about 3 operations per message; 4-day retention (up to 14). 360k messages/month = $0.03. | [C16] |
| Workers AI | $0.011 per 1,000 neurons; 10,000 neurons/day free. **TTS**: `@cf/myshell-ai/melotts` $0.000205 per audio minute (about $20/month for our 55 audio-hours/day) but its model page says **"Planned Deprecation 11/20/2026"**, the day after this research, so it is not a plan; `@cf/deepgram/aura-1` $0.015 per 1k chars and `@cf/deepgram/aura-2-en` $0.030 per 1k chars (partner models), i.e. $45 to $90 per day, $1,350 to $2,700 per month at 3.0M chars/day. LLM examples: Qwen3-30B-A3B-FP8 $0.051 in / $0.335 out per M tokens; gpt-oss-20b $0.20 / $0.30; Gemma 4 26B-A4B $0.10 / $0.30; Granite 4.0 H Micro $0.017 / $0.112; Llama 3.1 8B fp8-fast $0.045 / $0.384. | [C17] |
| Containers | **CPU only.** Instance types lite (1/16 vCPU, 256 MiB) up to standard-4 (4 vCPU, 12 GiB), plus custom. $0.000020 per vCPU-second (active use only), $0.0000025 per GiB-second and $0.00000007 per GB-second (provisioned); included 375 vCPU-min, 25 GiB-h, 200 GB-h; egress $0.025/GB (NA/EU) after 1 TB. The product page lists "GPU support (coming soon)"; the Containers changelog up to 30 Sep 2026 never mentions GPU. | [C18] |
| Workers KV | $0.50/M reads after 10 M; $5.00/M writes after 1 M; $0.50/GB-month. Eventually consistent, so not a sub-second live channel (propagation time not re-verified). | [C19] |
| Pages | Static assets free and unlimited; 20,000 files, 25 MiB per file, 500 builds/month on Free; Functions bill as Workers. | [C20], [C1] |
| K2 (event log, beta) | $0.04/GB produced, $0.04/GB consumed, $0.02/GB-month retained; billing not enabled yet; 10 GB cap per account in beta. Not a browser fan-out tool; Queues covers our ingest need. | [C21] |
| Tiered Cache | Free on all plans with Smart topology (one upper tier near the origin; R2 docs recommend it for custom domains). Generic Global, Regional and Custom topologies are Enterprise only. | [C10], [C5] |
| Cache Reserve | Needs a paid plan, an asset TTL of at least 10 h, and **requests to R2 public buckets on your zone do not use it**. Skip. (Now sold inside "Smart Shield Advanced", not available to Free/Pro/Business.) | [C11], [C12] |
| PartyKit hosted | **Shut down on 23 Oct 2026.** The surviving path is PartyServer (a library) on Workers + Durable Objects in your own account, i.e. mechanism (c) below. | [C24] |

### 2.2 Serving R2 through the CDN: what is and is not billed

- **Custom domain required** for cache, WAF, Access and Bot Management; use Smart Tiered Cache so one upper tier sits next to the bucket [C5].
- **Cache hits and R2 operations.** R2 bills Class A/B operations on requests that reach R2; the docs do not spell out cache hits, but a hit answered at the edge never reaches R2. Treat this as UNVERIFIED-by-doc, verify on day 1 with the R2 operations metric (GraphQL/dashboard) in a canary: compare Class B counts with the cache on and off. Misses cost one Class B per fill ($0.36/M).
- **Default caching is by file extension**; `.json`, `.m3u8`, `.m4s`, `.aac`, `.opus`, `.m4a` are not in the list (MP3, MP4, OGG, WEBM, FLAC, MIDI are). Add a Cache Rule "Eligible for cache" on the media hostname [C6]. Default edge TTL when no header: 200/206/301 120 min; 404/410 **3 min** (a cached "not yet" 404 on a predictable next-file URL would stall clients; do not poll nonexistent immutable URLs, poll the head instead).
- **TTL floors.** The documented minimum *Edge Cache TTL setting* is 2 h on Free, 1 h on Pro, **1 s on Business and Enterprise** [C7]. Origin `Cache-Control` is followed as specified on Free/Pro/Business ("Origin Cache Control" default on): `max-age=3600` means 3,600 s [C8]. So a short TTL has to come from the origin header (R2 object metadata `cacheControl` set at PutObject), not from a Cache Rule override. Whether `max-age=2` is honored on a Free zone is **not stated explicitly**: test it, and if it is not, move the zone to Business ($) or add a Worker for `head.json` only.
- **Stale-while-revalidate is now fully asynchronous**: the first request after expiry gets stale content (`UPDATING`) and triggers one background revalidation; `s-maxage`, `must-revalidate`, `proxy-revalidate` and `no-cache` disable it [C9]. Use `Cache-Control: public, max-age=2, stale-while-revalidate=10` on `head.json` (no `s-maxage`).
- **Request collapsing**: per data center, concurrent misses for one uncached asset are held behind a cache lock; only the first goes upstream and the response is streamed to all waiters [C6]. With Smart Tiered Cache the chain is lower-tier colo, then the single upper tier, then R2. For a 2-second-TTL object the origin therefore sees at most about one request per TTL per upper tier (0.5/s = 1.3 M Class B/month per upper tier; if ten upper tiers refill that is 13 M, $1.07/month after the 10 M free), regardless of whether 1k or 100k clients poll. Whether staleness stacks across the two tiers is UNVERIFIED; measure `Age`.
- **No per-request or per-GB meter on the CDN itself**: the CDN rows on the plans page are flat per plan, while Workers, R2, DO and Queues are metered (verified by absence on [C26b], not an explicit sentence). 86 B polls/month at 100k sustained viewers is 33k rps on one hostname: unusual for a Free zone; expect to talk to Cloudflare (thresholds UNVERIFIED).
- **ToS clause** [C23]: "Cloudflare's CDN ... can be used to cache and serve web pages and websites. Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN. Cloudflare reserves the right to disable or limit your access ... if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files." Audio stored in R2 sits inside the Developer Platform, so the intended path is compliant. At 100k concurrent (about 800 TB/month) this is a commercial conversation, not a pricing-page question.
- **What not to do**: Workers on the polled path (86 B requests x $0.30/M = $25.9k/month), Cache Reserve, `r2.dev`, query-string cache-busters on `head.json`, one object per tiny curve file (use one bundle per comment).

### 2.3 Live updates for about 100k concurrent clients

Model: comments become playable at about 0.14/s on average (12,000/day, bursts to 0.6/s); sessions 20 min; C concurrent viewers sustained for H hours/day (viewer-hours = C x H x 30); polling interval 3 s, TTL 2 s; 8,000 sockets per DO shard (assumption). `cost_model.py` reproduces the dollar columns; free allowances applied; the $5 Workers base is counted once in section 6, not here.

| Mechanism | Latency to client | $/month at 1k / 10k / 100k, 24 h/day | $/month at 1k / 10k / 100k, 8 h/day | Notes |
|---|---|---|---|---|
| **(a) Poll CDN `head.json` (2 s TTL, SWR) + immutable delta/bundle files** | mean about 2.5 s, p95 about 5 s (poll wait mean 1.5 s + cache staleness mean 1 s; SWR can serve one extra stale cycle) | $1.07 / $1.07 / $1.07 (R2 refills only; 0.9 B / 8.6 B / 86.4 B polls) | same | No state, no Worker, graceful degradation, plain HTTP caching. Manifest bytes: about 1 to 2 KB x 86 B = 90 to 170 TB/month at 100k (use `ETag` and 304s). Needs the Cache Rule and a verified short-TTL behavior (2.2). |
| (a') Live HLS playlist as the manifest | same as (a); hls.js polls about every target duration | same | same | The pocket player needs this playlist anyway (section 3); the in-scene player can read the same file. |
| **(b) SSE from Workers** (one Worker request per session, streaming from DO shards that cannot hibernate) | 0.1 to 0.5 s | $0.17 / $13.39 / $184.30 | $0.00 / $1.77 / $55.60 | Cost is requests ($0.30/M Worker, $0.15/M DO) plus about 13 always-on shard DOs at about $4 each ($12.50/M GB-s x 0.125 GB x 2.59 M s). Worse than (c) on cost and failure modes. Connections are cut within 20 min of any runtime update, so reconnect logic is mandatory. |
| **(c) DO WebSocket hibernation fan-out**, server-to-client only, auto-response pings | 0.1 to 0.5 s (plus RTT to the shard's region) | $0.23 / $6.94 / $102.79 | $0.01 / $1.04 / $32.23 | Billing is almost all connection requests: 216 M/month at 100k sustained x 3 sessions/hour ($0.30 Worker + $0.15 DO per M). Outgoing messages are free. If clients also sent a heartbeat message every 30 s it would add about $65/month; use `setWebSocketAutoResponse`. Needs sharding (about 13 shards of 8k), a broadcast tree (ingest DO to shard DOs by RPC), reconnect jitter, and a 1,000 req/s soft limit per DO in mind. |
| **(d) Third-party** | 50 to 150 ms (vendor-typical, UNVERIFIED) | Ably (MAU priced, Pro annual): $29 at 1k MAU, $129 at 5k, $249 at 10k, $1,149 at 50k; above 50k "contact us"; extra MAU $0.05 [C25]. Pusher fixed plans: 1k conns Pro $99 (4 M msgs/day); 10k conns Premium $499 or Growth $699; **top plan $1,199 = 30k connections and 90 M messages/day; 100k = Enterprise** [C25]. | | Pricing scales with viewers, the opposite of the principle. MAU is unique users per month, so 100k concurrent means millions of MAU. Pusher counts every delivered message (one publish to 50 subscribers = 51). PartyKit hosted is gone (23 Oct 2026); PartyServer = (c). |

Verdict. Start with (a): it is free, stateless, and the 3 s average added latency is small next to the feed's 18 s mean. If measurement shows the extra 2 to 3 s matters, add (c) as a *nudge channel* only (messages like `{"seq": 123456}`), so the media and manifests still flow through the CDN and a WebSocket outage degrades to polling. Do not use (b) or (d).

---

## 3. Audio delivery formats and browser support (iOS first)

Method: Apple's Safari release notes (saved copies of `developer.apple.com/tutorials/data/documentation/safari-release-notes/safari-<ver>-release-notes.md`), Apple's HLS authoring specification and the IETF HLS draft -22, MDN browser-compat-data, caniuse, the hls.js README, WebKit bug references quoted in those notes, and the Apple developer forums [A1 to A9]. No iPhone was available: everything marked UNVERIFIED-device needs a real device.

### 3.0 Read first

- **Safari 27 has shipped.** Apple's own notes: "Released September 14, 2026 - 27.0 (20625.1.29)", available on iOS 27, macOS 27 and macOS 26/Sequoia; 27.1 and 27.2 exist [A1]. The brief says "Safari 26"; test iOS 18.x, 26.x and 27.x, because 26.x users will not all move.
- **Some decode fixes exist only in 27.x** (Apple release notes): MP4 with Opus tracks could not be decoded by `decodeAudioData` until 27.0 (170196423); "media playback could not move to the next item in a playlist when the tab was in the background" until 27.0 (172676372); `MediaSession.setActionHandler` threw until 27.0 (178167294); **`AudioContext.decodeAudioData()` failed with an `EncodingError` on valid AAC/M4A files until 27.2 (183474728)** [A1].
- **Opus is the weak link on iPhone**, not the strong one: Apple's HLS authoring spec contains no mention of Opus [A2]; an Apple Media Engineer wrote in Jul 2024 that Opus "is only supported beginning in iOS 17, and only in MP4 files ... not listed as a supported codec in either the Guidelines or the Tech Specs" [A3].
- **Pick on this evidence: AAC-LC in packed ADTS with an ID3 PRIV timestamp tag, one file per clip.** Unproven on device (section 3.8).

### 3.1 Support matrix

| Item | iPhone Safari | macOS Safari | Chrome | Firefox | Evidence |
|---|---|---|---|---|---|
| Opus in Ogg, `<audio>` | 18.4+ | 15.4+ | yes | yes | Apple 18.4 notes: "Added support for Ogg Opus and Ogg Vorbis on macOS Sequoia 15.4, iOS 18.4 ..." [A1] |
| Opus in WebM | 17.4+ (WebM on iOS) | since 15 | yes | yes | Apple 15: "Added support for the Opus audio codec in WebM containers"; 17.4: "VP8/VP9 and WebM on iOS and iPadOS" [A1] |
| Opus in MP4/fMP4 | `<audio>`/HLS unofficial from iOS 17; `decodeAudioData` broken until 27.0 | stereo-only Opus in MP4/WebM on Sonoma | UNVERIFIED | UNVERIFIED | Apple 17 and 27 notes, forum 759210 [A1], [A3] |
| AAC-LC / HE-AAC in M4A, fMP4, ADTS; MP3 | yes | yes | yes | yes (OS decoder) | MDN BCD [A7] (secondary) |
| `decodeAudioData` on AAC/M4A | **EncodingError bug until 27.2** | same engine (UNVERIFIED which macOS) | UNVERIFIED | UNVERIFIED | Apple 27.2 notes [A1] |
| `decodeAudioData` on ADTS (with or without a leading ID3 tag), fMP4 init+moof, Ogg-Opus, WebM-Opus | **UNVERIFIED-device** | same | same | same | no source found |
| MSE | **no MSE on iPhone**; ManagedMediaSource from 17.1 (a 17.0 preview), only when AirPlay alternative or remote playback disabled; 27.2 fixed a `startstreaming` stall on seek | MSE + MMS | MSE | MSE | MDN BCD (safari 17 / iOS 17.1), Apple 17 and 27.2 notes |
| WebCodecs `AudioDecoder`/`AudioEncoder` | **26.0** | 26.0 | 94 | 130 (desktop) | Apple 26 notes "Added support for WebCodec's AudioEncoder and AudioDecoder. (142916087)", WebKit blog Jun 2025 [A8], BCD [A7]; codec strings and ADTS framing in Safari UNVERIFIED-device |
| Native HLS | yes | yes | unreliable (use hls.js) | none (use hls.js) | hls.js README [A9] |
| Media Session | 15 | 15 | 73 | 82 | BCD |
| `navigator.audioSession` (`type` only) | 16.4 | 16.4 | no | preview | Apple 16.4 notes: "a subset of the AudioSession Web API"; BCD |

### 3.2 Apple HLS rules that shape the design (authoring spec [A2], IETF HLS draft -22 [A4])

- Codecs listed: AAC-LC, HE-AAC v1/v2, xHE-AAC, ALAC, FLAC, APAC, AC-3, E-AC-3. Rule 2.1: "Audio data SHOULD be provided as an elementary audio stream or in fMP4."
- **Packed audio** (ADTS AAC, MP3, AC-3, E-AC-3; no init section): "Each Packed Audio Segment MUST signal the timestamp of its first sample with an ID3 Private frame (PRIV) ... 'com.apple.streaming.transportStreamTimestamp' ... a 33-bit MPEG-2 PES timestamp ... Clients SHOULD NOT play Packed Audio Segments without this ID3 tag." (draft section 3.1.3). The tag is about 73 bytes.
- **fMP4**: every `traf` MUST have a `tfdt`; `EXT-X-MAP` MUST be present; decode times MUST be consistent with the previous segment.
- Continuity: rule 7.1 "Your media MUST be continuous across segments, with the exception of transitions for ads and other inserted material"; `EXT-X-DISCONTINUITY` MUST be present when the timestamp sequence changes, clients "MUST be prepared to reset its parser(s) and decoder(s)"; rule 8.17 `EXT-X-DISCONTINUITY-SEQUENCE` MUST always be present if a discontinuity can occur in live content (increment it when a tagged segment leaves the window).
- Live playlist rules: at least six segments (8.11), SHOULD hold at least 15 minutes (8.12), `EXT-X-PROGRAM-DATE-TIME` in every live playlist (8.4), target duration SHOULD be 6 s (7.5), segments MUST NOT exceed it by more than 0.5 s (7.7), EXTINF rounded must be at most TARGETDURATION ("longer segments can trigger playback stalls"), no redirects on media requests (8.18), gzip playlists (10.1). The server must not shrink a live playlist below 3 target durations; hold-back and the default start are at least 3 target durations from the end.
- **Stale-playlist stall**: if a playlist is unchanged for 1.5 target durations the client "MAY conclude that the server is not behaving properly"; iOS logs `CoreMediaErrorDomain -12888`. An Apple Systems Engineer (forum 783255, May 2025): "a server (including any CDN) must provide an updated live playlist every target duration." So the playlist must advance even when no comment is ready (silence/filler segments) [A5].
- Low-Latency HLS needs blocking playlist reload and preload hints; behind a plain cached CDN clients fall back to regular HLS. Not needed for 5 to 30 s clips.

### 3.3 Background, lock screen, Media Session on iOS

- **Defaults** (W3C Audio Session draft; WebKit 237322): `AudioContext` defaults to `ambient` (muted by the ringer switch), `<audio>` to `playback`. "Since iOS 17, you can set `navigator.audioSession.type = "playback"` and audio will not be suspended" [A6].
- **Lock/background**: WebKit 261554 ("AudioContext is getting suspended when page goes in the background even if audioSession.type is playback") broke in 17.0, was fixed in 17.1, broke again in 17.2 to 17.3 and was reported fixed in 17.5: fragile. A third-party report (Oct 2026, iPad, secondary): Web Audio stops on lock by default; with `playback` it keeps playing and gets lock-screen play/pause; `<audio>` keeps playing without it. `playback` pauses other apps' audio (WebKit 264473). iPhone behaviour on 26/27: UNVERIFIED-device.
- **`<audio>` + live HLS in the background**: Apple 15.6 ("starting audio playback ... when the device is locked"), 17.5 ("continue to the next media activity when in the background"), 27.0 ("could not move to the next item in a playlist when the tab was in the background"). Prefer one long-lived HLS element over per-clip `src` swaps. 17.2: very short `<audio>` clips no longer register as Now Playing.
- **Media Session**: works from 15; wrap `setActionHandler` in try/catch (throws before 27.0); `seekto`, `previoustrack`/`nexttrack` and `setPositionState` for a live stream on iPhone: UNVERIFIED-device.
- **Web Audio into `MediaStreamAudioDestinationNode` into `<audio>`** to get lock-screen behaviour: only a 2023 WebKit comment (bug 251532, "probably fixes ... a bit less efficient"); no 2026 test found. UNVERIFIED-device.
- Home Screen web app: 26.2 fixed "an audio element failed to play when re-opening a Home Screen Web App"; Web Audio silent after returning from background is reported as possibly open (UNVERIFIED).

### 3.4 Gapless playback and encoder delay

- Apple (preparing audio for HLS): fMP4 can carry an `elst` edit list: "starting with iOS 13.1 ... `media_start` is equivalent to the audio priming duration ... recommended for CMAF."
- Which engines' `decodeAudioData` honour `elst`, LAME gapless info or Opus pre-skip: not found; UNVERIFIED-device for all.
- ADTS carries no priming metadata, so every engine should decode the priming samples the same way. Store the exact PCM sample count and priming offset in the per-comment sidecar and compensate with `source.start(when, offset)`. AAC priming is 2,112 samples = 88 ms at 24 kHz: invisible as a gap in speech, visible against lip-sync, so calibrate it once per engine.
- Speech clips separated by natural pauses (the prototype already inserts 350 to 600 ms) do not need sample-exact gapless playback; schedule with `AudioContext.currentTime` look-ahead.

### 3.5 Can ONE set of per-comment files serve Web Audio and an HLS pocket player?

| Candidate | iOS native HLS | hls.js (Chrome, Firefox) | Web Audio decode | Verdict |
|---|---|---|---|---|
| (b) **ADTS `.aac` per clip with leading ID3 PRIV** | spec path for packed audio, Apple recommends elementary audio | transmuxed by hls.js | UNVERIFIED-device; mitigation: strip the 73-byte tag client-side (ADTS re-syncs) | **best candidate** |
| (a) fMP4 AAC per clip, shared init (`EXT-X-MAP`), `tfdt` from 0 plus a discontinuity | spec-correct | MSE passthrough | init+segment concatenation UNVERIFIED; AAC/M4A decode bugs fixed only in 27.0 and 27.2 | second choice |
| (c) two sets (M4A for Web Audio, fMP4 or ADTS for HLS) | fine | fine | fine | works; 1 M clips x 15 s x 24 kbps = 45 GB per set, so under $1/month on R2; the cost is a doubled pipeline and cache keys. Cheap insurance if (b) fails on device |
| (d) MPEG-TS | works | works | a Web Audio decoder is unlikely to demux TS | no (188-byte packets) |
| (e) Opus in fMP4 | unofficial (iOS 17+) | "subject to runtime support" | `decodeAudioData` fails on iOS up to 26 | not as the single format |

Timestamps: immutable per-clip files carry fixed ID3/`tfdt` timestamps, so each clip enters the playlist behind an `EXT-X-DISCONTINUITY` with `EXT-X-DISCONTINUITY-SEQUENCE` kept right (spec path; audibility of the transition on iOS native is UNVERIFIED-device). If one global append-only order exists, assign cumulative timestamps at encode time and avoid discontinuities (the ID3 clock wraps at about 26.5 h).

**A pocket stream cannot carry everything.** HN produces 2.3 s of speech per wall-clock second (55.6 h/day), a listener consumes 1 s per second. A live playlist is therefore a selection (a radio per floor, per top-N stories, per user follow set), built from the same immutable segments; only the small `.m3u8` differs per channel.

**Window arithmetic.** TARGETDURATION must cover the longest clip, and the hold-back/join point is at least 3 x that. With raw comments of 5 to 30 s: TD 30, join 90 s, stale deadline 45 s, window of at least 90 s: it does not fit a 60 to 120 s window. **Split long comments into sentence-level clips of at most 10 s at synthesis time**: TD 10, join about 30 s, stale deadline 15 s, a 60 to 120 s window is 6 to 12 entries (the spec still wants at least six segments and recommends 15 minutes, about 90 entries, a 6 to 8 KB text file). 1 to 3 s segments are not needed. The pocket player is a radio, so a join delay of about 30 s is acceptable; the in-scene player does not use the playlist.

### 3.6 Bitrate, quality and bytes per clip

Listening-test evidence for Opus vs HE-AAC vs AAC-LC on TTS speech could not be retrieved (the Xiph page failed on an expired certificate); quality at 24 to 32 kbps is **UNVERIFIED: A/B test on your own voices**. Opus is better at the low end, but Opus is exactly what iPhone HLS and `decodeAudioData` do not support reliably, and HE-AAC in ADTS has implicit SBR signalling that decoders may mis-handle (UNVERIFIED), so start with AAC-LC mono 24 kHz at 32 kbps and compare 24 and 48 kbps.

| Bitrate | bytes/s | 15 s clip | per minute | per viewer-hour |
|---|---|---|---|---|
| 16 kbps | 2,000 | 30,000 B | 120 KB | 7.2 MB |
| 24 kbps | 3,000 | 45,000 B | 180 KB | 10.8 MB |
| 32 kbps | 4,000 | 60,000 B | 240 KB | 14.4 MB |

Overheads (computed, not measured): ADTS 7 B/frame = about 164 B/s (about 2.5 KB per 15 s); ID3 PRIV tag 73 B; fMP4 `moof` about 1.5 KB (AAC) to 3.1 KB (Opus, 20 ms frames) per 15 s plus a 0.5 to 1 KB init; HTTP request about 0.5 to 1.5 KB, 1 to 3% of a 45 KB object. For scale: the prototype's 24 kHz 16-bit mono WAV is 384 kbps, 12 to 16x these.

### 3.7 Recommendation

- **File**: one ADTS AAC-LC mono 24 kHz file per clip (at most 10 s), 32 kbps to start, leading ID3 PRIV with a constant timestamp (test 0 and 900000), content-hashed immutable URL, `Content-Type: audio/aac`; a JSON sidecar with exact sample count, priming offset, text and emotion tag (this is also where the lip-sync curves live).
- **Pocket playlist**: media playlist (no multivariant), TARGETDURATION = longest clip rounded up (at most 10), `EXT-X-MEDIA-SEQUENCE` advancing, `EXT-X-DISCONTINUITY-SEQUENCE` always present, `EXT-X-DISCONTINUITY` and `EXT-X-PROGRAM-DATE-TIME` before each clip, window at least max(6 entries, 3 x TD plus margin), playlist TTL 1 to 2 s, filler segments so it changes at least once per TD.
- **Players**: iOS Safari native HLS (hls.js with ManagedMediaSource as fallback); Chrome and Firefox hls.js. Tower: `fetch` + `decodeAudioData`.
- **Fallback ladder for Web Audio**: ADTS with ID3 fails to decode, so strip the tag and retry; still fails, so try WebCodecs `AudioDecoder` (26.0+); still fails, so decode with a small WASM AAC or Opus decoder, or generate set (c) only for the failing browsers. If Web Audio dies on lock, hand over to the HLS `<audio>` on `visibilitychange`.

### 3.8 What must be tested on a real iPhone first (iOS 26.x and 27.x, Safari tab and Home Screen app)

1. Live ADTS+ID3 HLS in `<audio>` with a discontinuity per clip, 20+ minutes with the screen locked: gaps and clicks, whether segments added while locked are picked up, and `-12888` when no clip arrives for more than 1.5 x TD.
2. The same with fMP4-AAC (shared init, `tfdt` from 0, discontinuity per clip) plus an Opus-fMP4 probe.
3. `decodeAudioData` on 26.x, 27.0, 27.1 and 27.2 with ADTS+ID3, ADTS, M4A, fMP4 init+moof, Ogg-Opus, MP4-Opus: compare `AudioBuffer.length` with the expected sample count, watch for `EncodingError`.
4. Web Audio with `audioSession.type='playback'`: lock, silent switch on, Spotify playing, call and Siri interruption, `interrupted` recovery; also the MediaStreamAudioDestinationNode into `<audio>` route.
5. Media Session on iPhone: artwork, play/pause, previous/next, `seekto`, `setPositionState` on a live stream; hand-off between the scene player and the pocket player; autoplay gesture.
6. Click-train calibration of priming offset and `start(when)` against lip-sync on iOS, macOS Safari, Chrome Android and Firefox.
7. Home Screen app lifecycle: re-open after background, Web Audio after returning to the foreground.
8. CDN details: no redirects, gzip playlists, correct MIME types, Range and CORS headers for hls.js.

---

## 4. TTS and lip-sync compute: GPU, CPU and serverless

### 4.0 What the workload really looks like

- 12,000 comments/day x 250 chars = 55.6 spoken hours/day (section 1.5). Busy GPU-hours/day = 55.6 / (speed multiple): 100x = 0.56, 33x = 1.7, 25x = 2.2, 17x = 3.3, 6x = 9.3, 1.2x = 46 h (one GPU cannot do it). The brief's 1 to 15 GPU-h/day corresponds to 55x down to 3.7x real time.
- **Arrivals come in HN's 34-second batches** (section 1.1): about 2,540 ticks a day, 4.7 live comments per tick on average (6.3 in the 15:00 to 16:00 UTC peak hour), so the GPU sees a burst of about 79 s of speech (105 s at peak) every 34 s, never a Poisson trickle. Any scale-to-zero container whose idle window exceeds the roughly 30 s gap between bursts is therefore billed 24 h/day.
- **Capacity target**: p99 of 5-minute windows is 81 comments (26k chars, about 5.9x real time) and the worst 5-minute window in Aug to Oct 2026 was 153 comments (47k chars, 10.4x). Size for 10x real time with a queue, not for the daily mean of 2.3x.

### 4.1 Serverless and per-second platforms (read 19 Nov 2026)

| Platform | Price | Idle / cold start / terms | Source and confidence |
|---|---|---|---|
| Modal | T4 $0.000164/s ($0.59/h), L4 $0.000222/s ($0.80/h), A10 $0.000306/s ($1.10/h), L40S $0.000542/s ($1.95/h), A100-40 $0.000583/s ($2.10/h), A100-80 $0.000694/s ($2.50/h), RTX PRO 6000 $0.000842/s ($3.03/h), H100 $0.001097/s ($3.95/h). CPU $0.0000131 per physical core-second (2 vCPU) and RAM $0.00000222 per GiB-second on top (about +$0.08/h for 1 core + 4 GiB) | Default scaledown window 60 s (billed; range 2 s to 20 min); containers "boot in about one second"; GPU memory snapshots alpha (blog: Parakeet-0.6B 20 s to 2 s, vLLM with a 0.5B model 45 s to 5 s; no first-party figure for a 10 GB model); one container serves many requests with `@modal.concurrent`; Starter plan $30/month credits, 10 GPU concurrency | [G1] modal.com/pricing and docs; verified (I re-read the price table raw) |
| RunPod Serverless | 16 GB class $0.58/h; 24 GB (L4, A5000, 3090) $0.75; RTX 4090 $1.34; 5090 and L40S $1.89; A100 $2.99; RTX PRO 6000 $3.69; H100 $5.89 (page "Updated November 12, 2026") | Per second, rounded up; idle timeout default 5 s (console) / 10 s (REST); FlashBoot on by default, no published timings; new accounts max 5 workers; active-worker discounts "through sales inquiry" | [G2] runpod.io/pricing, docs.runpod.io; high |
| Replicate | T4 $0.81/h, L40S $3.51, A100-80 $5.04, H100 $5.49; private models also bill idle time | Cloudflare announced it was acquiring Replicate on 17 Nov 2025; secondary sources say it closed in early 2026; the pricing page does not mention Cloudflare | [G5] replicate.com/pricing (verified raw); acquisition [G6], secondary |
| fal | RTX PRO 6000 $4.00/h list ("as low as" $1.99), H100 $4.50 ("as low as" $2.49); per second including idle runners; no small GPUs | no cold-start data found | [G5] fal.ai/pricing; high |
| Baseten | T4 $0.63/h, L4 $0.85/h, A10G $1.21/h, H100 $6.50/h | scale-to-zero not stated | [G5] baseten.co/pricing; medium |
| Beam | RTX 4090 $0.69/h, 5090 $1.09/h; Developer plan $20/month incl. $20 credit, 5 concurrent GPUs | no cold-start data found | [G5] beam.cloud/pricing; medium |
| Koyeb | RTX 4000 SFF Ada 20 GB $0.50/h, L4 $0.70/h, L40S $1.20/h; per second, scale-to-zero (Mistral AI announced it was acquiring Koyeb on 17 Feb 2026; platform keeps running) | | [G5], [G6] koyeb.com/pricing; medium |
| Northflank | L4 $0.80/h, A100-80 $1.76/h; per second | | [G5] northflank.com/pricing; medium |
| Cloudflare Workers AI / Containers | **No GPU in Containers** (largest 4 vCPU / 12 GiB, "GPU support (coming soon)"). Workers AI TTS: **MeloTTS $0.000205/audio-minute (about $20/month for us) is marked "Planned Deprecation 11/20/2026" on its model page**; the remaining Cloudflare-listed TTS models are Deepgram Aura-1 $0.015 and Aura-2 $0.030 per 1k chars = $1,350 and $2,700 per month at 3.0M chars/day | | C17, C18; verified |
| Fly.io GPU, TensorDock, Scaleway, OVH, Latitude, Hyperstack, Vultr, DigitalOcean | not researched or page blocked | | UNVERIFIED |

### 4.2 Rented and dedicated (read 19 Nov 2026; EUR 1 = USD 1.0968, ECB 18 Nov [X1])

| Item | Price | 24x7 monthly | Notes and source |
|---|---|---|---|
| **Hetzner GEX45** (i5-13500, 64 GB, **RTX PRO 4000 Blackwell SFF 24 GB**, Helsinki only) | EUR 214/month, EUR 209 setup, hourly EUR 0.3429 (a month of hours = EUR 247, so monthly is cheaper) | **$235/month** (+ $229 once) | [G3] hetzner.com/dedicated-rootserver/matrix-gpu, verified by me. Unlimited traffic at 1 Gbit/s, no minimum term. The GEX44 and GEX130 URLs now redirect to the GEX45 and GEX131 pages: treat both as retired. A secondary source reports a 16% GEX44 rise on 1 Apr and a repricing on 15 Jun 2026 |
| Hetzner GEX63 (RTX PRO 6000 Blackwell Max-Q 96 GB, 20 cores) | EUR 999/month + EUR 999 setup | $1,096 | same page; verified |
| Hetzner GEX131 | from EUR 1,499/month + EUR 1,499 setup | $1,644 | same page; verified |
| Hetzner AX42 (CPU, Ryzen 7 PRO 8700GE, 8c/16t) / AX102 | EUR 79 + EUR 49 setup / EUR 159 + EUR 129 setup | $87 / $174 | [G4] hetzner.com/dedicated-rootserver/matrix-ax, verified by me. Hetzner Cloud has no GPU instances |
| RunPod pods (Secure / Community) | RTX 4090 $0.89 / $0.34 per h; RTX A5000 $0.27 / $0.16; L4 $0.69 / $0.44; RTX 5090 $1.39 / $0.69; storage $0.10/GB-month container disk | 4090: $641 / $245; A5000: $194 / $115; L4: $497 / $317 | [G2] runpod.io/pricing; high for Secure, medium for Community ("from" prices, stock-limited) |
| Vast.ai RTX 4090 | about $0.31 to 0.80/h on-demand, interruptible about $0.15 to 0.20 | $223 to 374; interruptible $108 to 144 | [G7] secondary trackers; low |
| Lambda A10 24 GB | $1.29/h | $929 | [G5] lambda.com/pricing; medium (tier mapping uncertain) |

VAT: Hetzner's docs say countries not in its VAT table (India is not listed) are invoiced without VAT (inference for India; the page does not name it).

### 4.3 How fast are open TTS models? (all secondary unless noted)

| Model | Evidence | Busy GPU-h/day for 55.6 audio-h |
|---|---|---|
| **Kokoro-82M** (Apache-2.0; what the prototype runs) | GPU [G9]: RTF 0.04 to 0.06 on an RTX 4090 (17 to 25x); another table 0.01 to 0.03 on 3090/4060 Ti/5090/RTX 6000 PRO (FP16, single stream, PyTorch). **CPU, measured 6 Jul 2026 on 4 vCPU Intel Xeon 8272CL**: ONNX RTF 0.64 (1.6x real time), PyTorch 0.66, UTMOS 4.44 [G10]; a 4 vCPU EPYC 7763 run gave 0.51 (ONNX) and 0.47 (PyTorch); a 32-core claim is about 5x | GPU 0.6 to 3.3 h; CPU 35 box-hours of 4 vCPU |
| **Supertonic-3** (ONNX, CPU) | same benchmark [G10]: 5-step (default quality) RTF 0.24 (4.2x), UTMOS 4.32; **2-step RTF 0.12 but UTMOS 1.53 (unusable)**; vendor card claims RTF 0.012 to 0.015 on an Apple M4 Pro CPU (not opened) | CPU 13 box-hours of 4 vCPU |
| Chatterbox-Turbo | vendor "up to about 6x"; third-party 1.2 to 15x | about 9 h at 6x |
| Orpheus-3B | real time needs about 83 tokens/s; 216 concurrent streams on one H100 after TensorRT-LLM + FP8 tuning (Baseten talk); no 4090 figure | 0.26 H100-h at 216x |
| Qwen3-TTS | exists (arXiv 2601.15621, 97 ms first packet); 1.3x on a Jetson AGX Orin (0.6B) | UNVERIFIED |
| Inflect-Nano-v1 (4.6M), Pocket-TTS (100M) | CPU RTF 0.14 (UTMOS 3.48), 0.71 (UTMOS 4.10) [G10] | n/a |
| F5-TTS, Piper, XTTS-v2, VibeVoice, Fish, Dia | not researched | UNVERIFIED |

I could not identify a single "most-hyped" TTS of Oct to Nov 2026 (UNVERIFIED). The repo's own choice, Kokoro, has measured numbers and a license that fits.

### 4.4 Lip-sync and viseme curves: no GPU needed

Kokoro's `KModel` returns per-phoneme predicted durations (`pred_dur`, frames of 600 samples = 25 ms at 24 kHz) next to the audio (`kokoro/model.py`, `Output.pred_dur`, read on GitHub 19 Nov 2026 [G8]), and the pipeline exposes the phoneme string, so a phoneme-to-viseme table gives mouth shapes with no extra model, no forced alignment and no extra latency. Fallbacks that also run on CPU: Rhubarb Lip Sync, Montreal Forced Aligner, wav2vec2-CTC alignment (URLs from memory, not opened: UNVERIFIED). NVIDIA Audio2Face-3D is the only option likely to want a GPU. Curves are about 12 visemes/s x 4 B + an emotion envelope: about 1 to 3 KB per comment (assumption).

### 4.5 Monthly cost of TTS compute (`cost_model.py`; Modal L4 as the serverless reference)

| Option | 1 busy GPU-h/day | 5 | 15 | Latency / note |
|---|---|---|---|---|
| Serverless per second, busy time only (ideal) | $24 | $120 | $360 | not achievable in real time |
| **Serverless, real time** (arrivals every 7 s keep the 60 s window warm) | $575 | $575 | $575 | meets 5 to 10 s; GPU only, CPU/RAM add about $0.08/h |
| Serverless, micro-batch every 5 min, 15 s cold start (assumption), 60 s idle | $168 | $264 | $503 | mean wait 2.5 min |
| Same with a 2 s idle window | $57 | $152 | $392 | mean wait 2.5 min |
| **Hetzner GEX45 24x7** | **$235** | $235 | $235 (62% busy) | setup $229 once; meets 5 to 10 s |
| RunPod Community RTX 4090 pod 24x7 | $245 | $245 | $245 | stock and reliability UNVERIFIED |
| Hetzner AX42 CPU box 24x7 | $87 | $87 | $87 | only with a fast CPU model; see below |

Break-even (busy hours/day where busy-only serverless equals the flat price): GEX45 9.8 h/day, RunPod Community 4090 10.2 h/day, versus a RunPod 4090 serverless endpoint at $1.34/h 5.8 h/day. Real-time serverless can never reach it, because the container is warm 24 h/day.

CPU pay-per-use for the same 55.6 audio-h/day (RTF from [G10], 4 vCPU): Kokoro ONNX $307/month on Cloudflare Containers ($0.000020 per vCPU-second), $203 on Modal CPU; Supertonic-3 5-step $115 and $76. A single AX42 (8 cores, 16 threads) has about 4x the cores of the benchmark box: Kokoro about 6 to 8x real time in multi-process use (extrapolation, UNVERIFIED) covers the 2.3x mean and the 5.9x p99 burst but not the 10x worst case. CPU adds latency: a 16.7 s clip takes about 10.7 s on 4 vCPU at RTF 0.64 (Supertonic-3: 4 s) against about 1 s on a GPU, so hop 5 of the latency budget grows by 3 to 10 s.

Managed references at 3.0M chars/day: Workers AI Aura-1 $1,350/month; ElevenLabs at $0.12 per 1k chars (HN Watercooler thread, 2025, secondary) $10,800/month.

### 4.6 Answer

- A steady 1 to 15 busy-GPU-hours/day workload with bursts is cheapest on a **flat-rate always-on box**, not on serverless: the 34-second arrival rhythm keeps any serverless container warm all day, so per-second billing degenerates to about $575/month for an L4 against $235 for a GEX45. Cheapest GPU-class options: RunPod Community pods ($115 to 245, availability UNVERIFIED) and the GEX45 ($235 + $229 setup, dedicated, in the owner's existing Hetzner account).
- Cheapest overall, if latency allows: **CPU-only** on an 8-core Hetzner AX42 ($87 + $54 setup) with Kokoro ONNX or Supertonic-3 5-step, at the price of 4 to 11 s of TTS latency and thin burst headroom. The existing homelab VPS is not an option (throttled under sustained CPU).
- Use **serverless GPUs for backfill only**: 1 month of history (about 330k comments, 1,530 audio-hours) is 77 busy GPU-hours at 20x, about $62 at $0.80/h; a year is about $740.
- A GEX45 at 24x7 has capacity for about 24 h x 25 to 100x = 600 to 2,400 audio-hours/day, 11 to 43x today's volume (those are 4090-class figures; the small-form-factor Blackwell card is slower than a 4090 by an amount I could not verify), so the cost stays flat until volume grows by roughly an order of magnitude, and it can also host the tagging model (1 to 2% of the GPU) and curve extraction.

---

## 5. LLM tagging (emotion and stance, about 40 output tokens per comment)

Workload: 12,000 comments/day x 30 = 360,000 calls/month; 300 input tokens (about 65 for the comment, the rest parent snippet, story title and a fixed system prompt) and 40 output tokens = 108 M input and 14.4 M output tokens/month. Rate is about 0.14 calls/s, so any entry-tier rate limit is irrelevant. Real-time needs a synchronous call within 1 to 3 s, so the 24-hour Batch API only fits backfill.

All first-party prices below were read on 19 Nov 2026. I re-checked the five that decide the ranking against the saved first-party pages (Haiku 5.5 also against the Claude API skill's pricing table, cached 6 Oct 2026). Thinking/reasoning is assumed OFF; it is ON by default on Haiku 5.5 (adaptive), GPT-6 Luna (`medium`), DeepSeek V4.1 Flash and Qwen3.7/3.8-Flash and is billed as output, which can multiply output cost 5 to 20x.

### 5.1 Prices (USD per 1M tokens)

| Model | In | Out | Cached in | Batch in / out | Terms that matter | Source |
|---|---|---|---|---|---|---|
| **Qwen3.7-Flash** (Alibaba Cloud, Singapore, up to 32K ctx) | 0.03 | 0.13 | implicit about 20% of list, explicit 10% (min 1,024 tokens, 5 min) | 0.015 / 0.065 | strict `json_schema`; 15k RPM; thinking on by default; snapshot 2026-07-15; alias floats; third-party endpoint | [L5] |
| **Claude Haiku 5.5** | 0.10 | 0.50 | 0.01 (5-min write 0.125, 1-h write 0.20); **min cacheable prompt 512 tokens** (Haiku 4.5: 4,096) | 0.05 / 0.25 | prompts up to 100k tokens (above: 0.50 / 2.50); GA JSON schema; entry tier 4,000 RPM; released 7 Oct 2026, retirement not before 7 Oct 2027; no Flex tier; may return `stop_reason: "refusal"` on toxic text; about 30% more tokens than Haiku 4.5 for the same text | [L2] |
| **GPT-6 Luna** | 0.10 | 0.50 | 0.01 (30-min write 0.125); **min 1,024 tokens** | 0.05 / 0.25; Flex (beta) same price | Fast tier 2x ($0.20/$1.00); reasoning default `medium`, set none; Build tier 5,000 RPM; **replaces GPT-5 nano/mini, shut down 11 Dec 2026**; OpenAI retires on about 6 months' notice | [L3] |
| Workers AI Qwen3-30B-A3B-FP8 | 0.051 | 0.335 | n/a | n/a | in-platform, no external key; quality unproven | [C17] |
| Gemini 2.5 Flash-Lite | 0.10 | 0.40 | 0.01 | 0.05 / 0.20 | "limited to existing users" | [L1] |
| Gemini 3.1 Flash-Lite | 0.25 | 1.50 | 0.025 | 0.125 / 0.75 | shuts down 7 May 2027 | [L1] |
| Gemini 3.5 Flash-Lite (stable since 21 Jul 2026) | 0.30 | 2.50 (includes thinking) | 0.03 + $1.00/M/h storage | 0.15 / 1.25 | Flex (preview, 1 to 15 min target); Priority 0.54 / 4.50; free tier data is used to improve Google products | [L1] |
| DeepSeek V4.1 Flash | 0.15 off-peak / 0.30 peak | 0.60 / 1.20 | 0.003 / 0.006 | no batch API; off-peak is -50% (peak: 01:00 to 04:00 and 06:00 to 10:00 UTC, Mon to Fri) | JSON mode only (valid JSON, not schema-enforced); 2,500 concurrent | [L4] |
| Claude Haiku 4.5 (older) | 1.00 | 5.00 | 0.10 (min 4,096) | 0.50 / 2.50 | superseded by Haiku 5.5 at 1/10 the price | [L2] |
| GPT-5 nano (shutdown 11 Dec 2026) | 0.05 | 0.40 | 0.005 | 0.025 / 0.20 | do not build on it | [L3] |
| Ministral 3 8B / Mistral Small 4 | 0.15 / 0.15 | 0.15 / 0.60 | 10% | -50% | 256K ctx | [L6] |
| gpt-oss-20b (Groq) | 0.075 | 0.30 | n/a | n/a | | [L7] |
| Llama 3.1 8B Turbo (DeepInfra) | 0.02 | 0.04 | n/a | n/a | weak on sarcasm (1 to 2B decoders collapse; 8B untested here) | [L8] |

### 5.2 Monthly cost at 12,000 comments/day (USD, 30 days)

A = list price, real time. B = with a 200-token cached prefix (only where a 200-token prefix is cacheable). C = batch price (backfill). D = 10 comments per request (system prompt amortised: 120 in / 40 out each), not usable in real time at 0.14 comments/s.

| Model | A | B | C | D |
|---|---|---|---|---|
| **Qwen3.7-Flash** | **5.11** | n/a (min 1,024) | 2.56 | 3.17 |
| Workers AI Qwen3-30B-A3B | 10.33 | n/a | n/a | about 7.0 |
| **Haiku 5.5** | **18.00** (about 23 at +30% tokens) | not cacheable at 200 tokens (min 512); 12.64 with a 512-token prefix | 9.00 | 11.52 |
| **GPT-6 Luna** | **18.00** | not cacheable (min 1,024); 14.49 with a 1,024-token prefix | 9.00 | 11.52 |
| DeepSeek V4.1 Flash | 24.84 off-peak / 49.68 peak (blend about 27 to 30) | 14.26 / 28.51 | n/a | 15.12 |
| Gemini 3.1 Flash-Lite | 48.60 | n/a | 24.30 | 32.40 |
| Gemini 3.5 Flash-Lite | 68.40 | n/a | 34.20 | 48.96 |
| Haiku 4.5 | 180.00 | n/a | 90.00 | 115.20 |
| Dedicated GEX45 (flat) | about 235 | | | |

Padding the cached prefix with few-shot sarcasm examples up to the cache minimum is cheaper than a bare 200-token prompt on Haiku 5.5 and GPT-6 Luna, and should also help the hardest label.

### 5.3 Self-hosting Qwen3 is not worth it unless the GPU already exists

Hetzner no longer lists the GEX44; the page serves the GEX45 (RTX PRO 4000 Blackwell SFF, 24 GB): EUR 214/month = $235 (ECB 1.0968) plus EUR 209 setup [G3]. At our load the box costs about $1.92 per 1M blended tokens against $0.15 for GPT-6 Luna and $0.04 for Qwen3.7-Flash; break-even versus Luna at list is about 156k comments/day (13x our volume). Published vLLM numbers (secondary): A10 24 GB Qwen3-8B FP16 about 850 decode tok/s [L9]; RTX 4090 7B bf16 about 3,577 tok/s [L10]; RTX 4090 Qwen3-30B-A3B AWQ about 2,259 tok/s at 1k/1k [L11]; RTX PRO 4000 Blackwell Qwen3-4B NVFP4 234 generated and 368 prompt tok/s (a single anecdote; Blackwell SM120 kernels were immature in April 2026, with a 3x regression in vLLM 0.18.1) [L12]. Prefill rates for the first three rows are roofline estimates, not measurements (UNVERIFIED). If a GPU is already rented for TTS, tagging adds 15 to 25 GPU-minutes/day (1 to 2%, about $2 to $4/month of GPU share; pessimistic Blackwell figure 3.3 h/day) and needs 6 to 12 GB of free VRAM beside the TTS model.

### 5.4 Quality evidence (thin, all secondary) and recommendation

- No head-to-head on terse-comment sarcasm or stance exists for these models (UNVERIFIED). Zero-shot GoEmotions with 28 labels is weak (about 26 macro-F1 for ChatGPT vs about 53 for a fine-tuned BERT), but 8 coarse labels are easier; zero-shot GPT-4 on Reddit SARC 2.0 is about 0.70 accuracy; 1 to 2B decoders collapse onto one class on sarcasm; prompted 7 to 8B models are competitive on stance. Aggregators rank Haiku 5.5 above GPT-6 Luna and Gemini 3.5 Flash-Lite below both; Qwen3.7-Flash is mid-table. Expect sarcasm to be the weak label.
- **Do first** (half a day): hand-label 300 recent comments, 40 of them sarcastic; score Haiku 5.5 (thinking off, effort low, a 512-token cached few-shot prefix, about $16/month), GPT-6 Luna (reasoning none), Qwen3.7-Flash and Workers AI Qwen3-30B-A3B; adopt the cheapest within about 2 F1 points.
- **Cheapest probably-capable**: Qwen3.7-Flash at $5/month (capability unproven; third-party Singapore endpoint). **Cheapest safe**: Haiku 5.5 or GPT-6 Luna at about $18/month list, $9 batch, $13 to $14.5 with a padded cached prefix. **Skip**: Gemini 3.5 Flash-Lite (3.8x the price), GPT-5 nano (gone 11 Dec 2026), a dedicated GPU.
- Risks: Haiku 5.5 safety classifiers can return a refusal on toxic comments (handle it; fall back to a neutral tag); GPT-6 Luna is a retiring-model risk on OpenAI's cadence and Flex is beta; Qwen3.7-Flash has a floating alias and thinking on by default.

---

## 6. Cost model

Everything below is reproduced by `cost_model.py` (`python3 -I cost_model.py --kbps 32 --hours-day 24`). Unit prices are in section 2 (Cloudflare), 4 (GPU/CPU) and 5 (LLM). 30-day month, EUR 1 = USD 1.0968.

### 6.1 Parameters

| Parameter | Value | Basis |
|---|---|---|
| Comments voiced per day | 12,000 | brief; measured 2026 mean 10,511 live and 11,283 all, weekday 11.2 to 11.7k, max day 14.8k (section 1.5) |
| Characters per comment | 250 | brief; measured mean 308, median 195, p90 697 |
| Spoken rate | 15 chars/s | about 150 wpm; gives 16.7 s per comment and **55.6 audio-hours/day** |
| Audio codec | AAC-LC mono 24 kHz, 32 kbps (24 kbps shown as sensitivity) | section 3.7; about 4.2 kB/s incl. ADTS |
| Curves + tag sidecar | 3 KB per comment | **assumption**, measure on 1,000 comments |
| Data per comment | 69.7 KB (53.0 KB at 24 kbps) = **25.1 GB/month new** (19.1 GB) | |
| LLM tokens | 300 in, 40 out per comment | brief; 108 M in + 14.4 M out per month |
| Busy GPU-hours/day | 1, 5, 15 (parameter) | = 55.6 x RTF; RTF 0.018, 0.09, 0.27 |
| Viewers | C = 1k, 10k, 100k concurrent, 20-minute sessions (3 per viewer-hour) | |
| Duty cycle | C sustained 24 h/day (ceiling) or 8 h/day (evening-peak profile) | viewer-hours/month = C x H x 30 |
| Client behaviour | poll `head.json` every 3 s (TTL 2 s); about 216 audio GETs per viewer-hour; 0.5% of audio GETs reach R2 | assumptions |
| WebSocket shard | 8,000 sockets per DO, 0.12 s of CPU per broadcast per shard | assumptions, load-test |

### 6.2 Costs that do not depend on viewers (USD/month)

| Component | Cost | Basis |
|---|---|---|
| Workers Paid base (only needed once a Worker, DO, Queue or Workers AI is used; variant A without the nudge needs none, so D2 is then $5 lower) | 5.00 | [C1] |
| Ingest/sequencer Durable Object, always on (128 MB x 2.59 M s = 324k GB-s, under the 400k free) | 0.00 | [C13] |
| Queues (360k messages x 3 operations; 1 M free) | 0.03 | [C16] |
| R2 writes (about 0.72 M Class A/month; 1 M free) | 0.00 | [C3] |
| R2 storage, everything kept: 1 month / 6 / 12 / 24 months at 32 kbps | 0.23 / 2.11 / 4.36 / 8.88 (24 kbps: 0.14 / 1.57 / 3.28 / 6.72) | [C3]: 25.1 GB/month x $0.015 after 10 GB free |
| LLM tagging, real time | Qwen3.7-Flash 5.11; Workers AI Qwen3-30B-A3B 10.33; Haiku 5.5 or GPT-6 Luna 18.00 (13 to 14.5 with a padded cached prefix; 9.00 batch); **Gemini 2.5 Flash-Lite 16.56 (what the prototype uses today)**; Gemini 3.5 Flash-Lite 68.40; Haiku 4.5 180.00 | section 5 |
| TTS compute | **$87 (CPU box), $235 (GEX45), $575 (serverless real time), $1,350 (Aura-1)** | section 4.5 |
| Domain, DNS, Pages (frontend) | 0.00 | existing; Pages static assets free |

### 6.3 Costs that depend on viewers (USD/month)

Audio egress and CDN bandwidth: **$0 on Cloudflare** (R2 egress free; the CDN has no per-GB meter), subject to the ToS clause in section 2.2. Reference only, the same traffic on Bunny's Volume Network ($0.005/GB to 500 TB, then $0.004 [C26]):

| C | Sustained | Viewer-hours/mo | Audio egress at 32 kbps (24 kbps) | Bunny Volume ref. at 32 kbps | R2 reads on cache misses | (a) poll CDN | (c) DO WebSocket nudge | (b) SSE via DO |
|---|---|---|---|---|---|---|---|---|
| 1,000 | 24 h/day | 720,000 | 10.9 TB (8.2) | $54 | $0.00 | $1.07 | $0.23 | $0.17 |
| 10,000 | 24 h/day | 7.2 M | 108.9 TB (81.6) | $544 | $0.00 | $1.07 | $6.94 | $13.39 |
| 100,000 | 24 h/day | 72 M | **1,088.6 TB (816.5)** | $4,677 | $24.39 | $1.07 | $102.79 | $184.30 |
| 1,000 | 8 h/day | 240,000 | 3.6 TB (2.7) | $18 | $0.00 | $1.07 | $0.01 | $0.00 |
| 10,000 | 8 h/day | 2.4 M | 36.3 TB (27.2) | $181 | $0.00 | $1.07 | $1.04 | $1.77 |
| 100,000 | 8 h/day | 24 M | 362.9 TB (272.2) | $1,814 | $5.73 | $1.07 | $32.23 | $55.60 |

Request counts at 100k sustained (24 h/day): 15.6 B audio GETs and 86.4 B manifest polls per month (33k rps); every one is a CDN hit except the 0.5% assumed misses and the head refills. Cost per 1,000 viewer-hours at 100k sustained with the optional nudge on: ($103 + $24 + $1) / 72,000 = **$0.0018**. If Cloudflare insists on Business for that volume: +$200/month annual or +$250 monthly [C26b]; Enterprise is a quote.

### 6.4 Monthly total by design (12 months of media kept, polling for live updates; the nudge is an add-on)

At 32 kbps, C sustained 24 h/day:

| Design | Fixed (TTS + LLM + CF base) | Total with 1k viewers | 10k | 100k | One-off setup | Optional DO nudge at 1k / 10k / 100k |
|---|---|---|---|---|---|---|
| D1 lean CPU: Hetzner AX42 + Qwen3.7-Flash | $101 | $102 | $102 | $127 | $54 | +$0 / +$7 / +$103 |
| **D2 recommended: Hetzner GEX45 + Haiku 5.5** | **$262** | **$263** | **$263** | **$288** | $229 | +$0 / +$7 / +$103 |
| D3 serverless GPU, real time (Modal L4) + Haiku 5.5 | $603 | $604 | $604 | $628 | $0 | +$0 / +$7 / +$103 |
| D4 managed TTS (Aura-1) + Haiku 5.5 | $1,377 | $1,378 | $1,378 | $1,403 | $0 | +$0 / +$7 / +$103 |

At 8 h/day the 100k column drops by $19 and the nudge add-on to +$32. At 24 kbps, storage falls by about $1/month and egress by 25%; nothing else changes. Gemini 2.5 Flash-Lite instead of Haiku 5.5 saves $1.44/month; Qwen3.7-Flash instead saves $12.89/month.

What scales with what: **TTS, LLM and storage scale with HN volume, and not with viewers** (D2's GPU is flat until about 11 to 43x today's volume; the LLM scales linearly: 24k comments/day doubles it); **viewers scale only the optional nudge (about $1 per 1,000 sustained viewers) and the 0.5% R2 misses**; egress is $0 on Cloudflare and about $54 per 1,000 sustained viewers on the cheapest alternative CDN.

### 6.5 Reading the GPU parameter

For g busy GPU-hours/day: flat box = F regardless of g (GEX45 $235, up to about 24 h/day); serverless with real-time arrivals = $575 regardless of g (warm 24 h); serverless busy-only = g x 30 x $0.7992 (g=1: $24, 5: $120, 15: $360); serverless micro-batched every 5 min = 288 x (g x 3600 / 288 + cold + idle) x $0.7992 / 3600 x 30 (g=5: $264 with 60 s idle, $152 with 2 s idle). Break-even of busy-only serverless against the GEX45 is 9.8 h/day; real-time serverless never reaches it.

### 6.6 Backfill (one-off, bursty, serverless-friendly)

One month of history is about 330k live comments = 1,530 audio-hours = 77 busy GPU-hours at 20x real time = about $62 on a $0.80/h serverless GPU, plus $5 to $17 of tagging (330k comments x 340 tokens, Qwen3.7-Flash to Haiku 5.5); a year is about $740 + $60 to $200. Each story's tree comes from one Algolia `items/<id>` request (section 1.3); 1 year of stories with at least 50 points is about 24k requests, 2.5 hours at the 10,000/hour limit, so pace it at about 5,000/hour.

---

## 7. Recommended architecture

### 7.1 Sketch (variant A: one processing box, Cloudflare for storage and fan-out)

```
   HN Firebase (34 s tick)  ---  Algolia items/<story> (seed + backfill only)
        |  SSE maxitem + updates; GET item/<id> with null-retry; ids are resumable
        v
 [1] INGEST + ORCHESTRATOR      Go service (the repo's backend/) on the Hetzner GEX45, Helsinki
        tree + status per front-page story, text hash, rev; skip dead/deleted; one monotonic seq
        a crash loses latency, not data: restart walks ids from the last seen
        |
        v
 [2] PROCESS (same box)         for each new/edited live comment, sentence-split to clips <= 10 s
        tag: LLM API call with parent context (Haiku 5.5 / GPT-6 Luna / Qwen3.7-Flash, thinking off)
        TTS: Kokoro on the GPU (RTF 0.01 to 0.06) ; visemes from Kokoro pred_dur ; AAC-LC encode (ADTS + ID3 PRIV)
        |  S3 PutObject to R2, immutable keys, Cache-Control: public, max-age=31536000, immutable
        v
 [3] STORE   R2 bucket on a custom domain (m.<domain>), Smart Tiered Cache, Cache Rule "eligible for cache"
        c/<id>/<rev>/<n>.aac       one clip, shared by tower and pocket players
        c/<id>/<rev>.json          sidecar: sample counts, priming offset, text, emotion tag, viseme curves (about 3 KB)
        f/<story>/d/<seq>.json     immutable per-floor deltas
        live/head.json             max-age=2, stale-while-revalidate=10, at most 1 write/s (R2 limit per key)
        live/<channel>.m3u8        live audio-only playlists (one per radio channel), max-age=2
        |
        v
 [4] FAN-OUT   Cloudflare CDN, no Worker on the read path.  Optional later: DO WebSocket "nudge" {seq} (about $103 at 100k)
        |
        v
 [5] CLIENT    tower: poll head every 3 s -> deltas -> prefetch next 3 clips -> fetch + decodeAudioData -> Web Audio schedule
               pocket: <audio> on a live HLS channel + Media Session; Web Audio hands over on visibilitychange
```

Variant B moves ingest, the sequencer and the queue to Cloudflare (a Worker + one SQLite Durable Object + Queues, about $5 to $10/month) and keeps only TTS on the GEX45. Choose it when the single box becomes the availability concern; nothing in the object layout changes. The Workers Paid plan ($5) is only needed once a DO, Queue or Worker is in use; R2 and the CDN work without it.

Why this shape: every byte a viewer touches is an immutable object or a 2-second-TTL JSON file served from Cloudflare's cache, so viewers cost nothing but free egress, and money is spent only where an HN comment is processed exactly once. The same immutable clip objects feed the Web Audio player and every HLS playlist; only the playlists and `head.json` change.

### 7.2 Latency budget, HN comment creation to audible (planning values; hops 2 to 8 are ours)

| # | Hop | p50 | p95 | Basis |
|---|---|---|---|---|
| 1 | HN to Firebase (34 s batch tick) | 18 s | 33 s | measured, 849 items |
| 2 | Detect and fetch item (SSE event, GET, null-retry) | 0.6 s | 3.4 s | measured (median 0.53 s, p90 3.4 s with retries) |
| 3 | Parent context lookup and queueing | 0.1 s | 0.5 s | assumption (tree is in memory) |
| 4 | Emotion/stance tag, 40 output tokens | 0.8 s | 2 s | UNVERIFIED: measure (section 5) |
| 5 | TTS of one 16.7 s comment: GPU / CPU | 1 s / 4 to 11 s | 4 s / 20 s | RTF 0.06 on GPU with burst queueing; Kokoro CPU RTF 0.64 (section 4.3) |
| 6 | Visemes, AAC encode, 2 PUTs to R2 | 0.5 s | 1.5 s | assumption |
| 7 | Publish `head.json`, CDN TTL 2 s, client poll 3 s | 2.5 s | 5 s | design values; verify `Age` (section 2.2) |
| 8 | Client fetch of a cache-miss clip and decode | 0.3 s | 0.8 s | assumption; hidden by prefetch |
| | **Ours (2 to 8), GPU variant** | **about 6 s** | **about 17 s** | |
| | **Total** | **about 24 s** | **about 50 s** | p95s do not add; a planning ceiling |

Two things dominate: the feed's 18 s mean, which nothing on our side can shorten, and the 2.5 s of polling, which a DO WebSocket nudge would cut to about 0.3 s. A CPU-only TTS adds 3 to 10 s at p50.

**"Starting playback must feel instant"** is a client property: keep the next 2 to 3 clips of the current table fetched and decoded into `AudioBuffer`s while the current clip plays (a clip lasts about 17 s, much longer than a cache miss), so a tap or a table switch starts from memory in well under 100 ms. Old comments are always CDN hits; a brand-new comment is the only cold fetch and the prefetch window hides it. The pocket player joins a live playlist 3 target durations back (about 30 s with 10 s clips): acceptable for a lock-screen radio, not for the scene.

### 7.3 Where each prototype component goes

The repo today builds one 24 kHz 16-bit WAV per thread (up to 15 comments, silences of 600 ms between siblings and 350 ms parent to child), runs Kokoro on CPU (`DEVICE=cpu`, 2 workers), calls `gemini-2.5-flash-lite` with a 10-label prompt (`maxOutputTokens: 50`), subscribes to `/topstories.json` and syncs every 2 minutes, storing audio on local disk and metadata in Postgres. Mapping:

- per-thread WAV becomes per-clip AAC: 384 kbps to 32 kbps is 12x less, which is 13 PB instead of 1.1 PB per month at 100k sustained viewers; the silences move to the client scheduler;
- follow `maxitem` + `updates` and fetch ids per tick; the 2-minute sync alone adds up to 120 s on top of the 34 s tick;
- keep Kokoro, move it from CPU to the GEX45 GPU (0.64 to 0.01 to 0.06 RTF), same code path;
- keep the Gemini call as the baseline ($16.56/month) and run the 300-comment eval against Haiku 5.5, GPT-6 Luna and Qwen3.7-Flash;
- local disk and Postgres become R2 and either the same Postgres on the box or DO SQLite; `edge-tts` (unofficial endpoint) stays a dev fallback only.

---

## 8. Open risks, UNVERIFIED items and the first experiments

### 8.1 Things this research could not settle (all marked UNVERIFIED above)

| # | Item | Why it matters | How to settle it |
|---|---|---|---|
| 1 | Does a Free-plan zone honor origin `Cache-Control: max-age=2` on R2 objects (the documented 2-hour floor applies to the Edge TTL override)? Does `Age` stack across lower and upper tier? | The whole poll design rests on a 2 s TTL | Canary bucket and custom domain; hit `live/head.json` from 5 regions for 10 minutes; read `cf-cache-status` and `Age`. If not honored: Business plan ($200/month annual, 1 s floor) or a Worker only for `head.json` |
| 2 | R2 Class B billing on edge cache hits (not stated in the docs) | R2 read cost at 100k viewers | Compare the R2 operations metric with cache on and off for 1 hour |
| 3 | Cloudflare tolerance for 33k rps and 800 TB/month on one zone, and the ToS audio clause | Commercial, not technical, risk at 100k | Ask Cloudflare sales before launch at that scale; keep audio in R2; consider Bunny Volume ($3.8k to $4.7k/month at 100k sustained, 24 to 32 kbps) as the documented fallback |
| 4 | DO sockets per shard (docs: "thousands"; 32,768 unofficial) and CPU per `send()` | Shard count for the optional nudge channel | Load-test 1 shard with 5k, 10k, 20k synthetic sockets and a 1 Hz broadcast |
| 5 | HN upstream: multi-hour SSE stability, behaviour when the new first-party API ships | Ingest availability | Run the ingester for a week with reconnect metrics; keep one adapter interface |
| 6 | BigQuery dataset freshness; whether the Hugging Face mirror moved | Only matters for backfill | ClickHouse covers it today |
| 7 | LLM sarcasm/stance accuracy of the cheap models | Tag quality drives avatars | 300-comment hand-labelled eval (section 5.4) |
| 8 | Which TTS model, its real RTF on the chosen hardware, and its emotion control | Decides GPU hours (section 4) | 3-model bake-off on 200 real comments |
| 9 | Per-comment curves size (3 KB assumed) | Storage and request bytes | Measure on the first 1,000 comments |
| 10 | Edit-window length on HN; share of comments edited after first voicing | Re-voicing cost | Track text-hash changes from `updates` for a week |

### 8.2 Policy and legal notes (risk framing, not legal advice)

- Voiced comments are third-party content under a ToU that grants YC, not us, a license (section 1.6). Always show the HN username and link to the item; drop media for `deleted` and `dead` items within one tick; keep a public takedown address; use generic synthetic voices only.
- The speech-reply feature cannot use an API (none exists) and HN's guidelines forbid generated and AI-edited comments and automated posting: dictation transcribed verbatim, posted by the user's own session, no LLM clean-up.
- Edge-TTS (an unofficial Microsoft endpoint) is already a fallback provider in the prototype; do not make an unofficial endpoint a production dependency.

### 8.3 First five experiments, in order (each under a day)

1. Cloudflare canary (item 1 and 2 above), plus the audio-format canary on a real iPhone (section 3.8).
2. TTS bake-off on 200 recent comments: RTF, cost per audio-hour, pronunciation of code/URLs, emotion control; pick the model and then the hardware (section 4).
3. Tagging eval on 300 hand-labelled comments (section 5.4).
4. Ingest spike: SSE `maxitem` + `updates`, null-retry, tree seeding from Algolia, write status to Postgres (variant A) or a DO (variant B); log creation-to-visible lag for a week.
5. Publish path spike: write bundles and `head.json` to R2, poll from 3 browsers, measure hop 7 of the latency budget end to end.

---

## Appendix A. Sources (URL, date read, how)

All read on 19 Nov 2026 (IST) unless a date is given. "raw" = fetched raw page or API and grepped; "probe" = measured by me.

### HN and data

| ID | Source | How |
|---|---|---|
| H1 | https://github.com/HackerNews/API (README.md; repo `pushed_at` 2025-01-01 via GitHub API) | raw |
| H2 | https://news.ycombinator.com/robots.txt (`Crawl-delay: 30`) | raw |
| H3 | https://hn.algolia.com/api, "Rate limits" section, taken from the page's own JS bundle https://hn.algolia.com/public/main-6e634771f729331a3c3c.js | raw |
| H4 | https://sql-clickhouse.clickhouse.com/?user=demo, database `hackernews` (ClickHouse 26.11.1; queried 18 to 19 Nov) | probe |
| H5 | https://motherduck.com/docs/getting-started/sample-data-queries/hacker-news/ (secondary, BigQuery lag) | raw |
| H6 | https://huggingface.co/datasets/open-index/hacker-news (card + API metadata) | raw |
| H7 | https://www.ycombinator.com/legal/ (Privacy Policy "Last Updated September 2026" and Terms of Use on the same page) | raw |
| H8 | https://news.ycombinator.com/newsfaq.html and https://news.ycombinator.com/newsguidelines.html | raw |
| H9 | dang, 2022-01-13: https://news.ycombinator.com/item?id=29927630 | Algolia items |
| H10 | dang, 2026-10-31 (new API): https://news.ycombinator.com/item?id=50320641, thread https://news.ycombinator.com/item?id=50319510 | Algolia items |
| H11 | dang, 2024-06-12: https://news.ycombinator.com/item?id=40653468 (thread 40644563 "Hacker News BigQuery dataset is updated daily again") | Algolia items |
| H12 | dang, 2026-02-13: https://news.ycombinator.com/item?id=47006862 | Algolia items |
| H13 | tomhow, 2026-07-13: https://news.ycombinator.com/item?id=48898096 | Algolia items |
| H14 | Prior-art threads: HackerFM https://news.ycombinator.com/item?id=34990229 (2023-03-02); The HN Recap https://news.ycombinator.com/item?id=35831177 (2023-05-05); HN Watercooler https://news.ycombinator.com/item?id=43720767 (2025-04-17); HackerTube https://news.ycombinator.com/item?id=50319510 (2026-10-31) | Algolia items |
| H15 | Moderator comments: dead https://news.ycombinator.com/item?id=49937936; moves/merges https://news.ycombinator.com/item?id=49758867, 49395631, 48799276, 50473642; detach https://news.ycombinator.com/item?id=50491904; vouch https://news.ycombinator.com/item?id=48729545; 2015 crawl incident https://news.ycombinator.com/item?id=9175457 | Algolia items |
| H16 | Probes P1 to P5 (Appendix B) | probe |
| H17 | Algolia live checks: https://hn.algolia.com/api/v1/items/44226145 (tree), `search_by_date` windows | probe |
| X1 | ECB reference rate EUR/USD 1.0968, EUR/INR 102.49 (2026-11-18): https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD,INR | raw |

### Cloudflare and pub/sub

| ID | Source | How |
|---|---|---|
| C1 | https://developers.cloudflare.com/workers/platform/pricing/ | raw |
| C2 | https://developers.cloudflare.com/workers/platform/limits/ | raw |
| C3 | https://developers.cloudflare.com/r2/pricing/ | raw |
| C4 | https://developers.cloudflare.com/r2/platform/limits/ | raw |
| C5 | https://developers.cloudflare.com/r2/buckets/public-buckets/ | raw |
| C6 | https://developers.cloudflare.com/cache/concepts/default-cache-behavior/ (dateModified 2026-09-14) | raw |
| C7 | https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/ (dateModified 2026-08-14) | raw |
| C8 | https://developers.cloudflare.com/cache/concepts/cache-control/ | raw |
| C9 | https://developers.cloudflare.com/cache/concepts/revalidation/ | raw |
| C10 | https://developers.cloudflare.com/cache/how-to/tiered-cache/ (dateModified 2026-11-03) | raw |
| C11 | https://developers.cloudflare.com/cache/advanced-configuration/cache-reserve/ | raw |
| C12 | https://developers.cloudflare.com/smart-shield/get-started/ | raw |
| C13 | https://developers.cloudflare.com/durable-objects/platform/pricing/ | raw |
| C14 | https://developers.cloudflare.com/durable-objects/platform/limits/ | raw |
| C15 | https://developers.cloudflare.com/durable-objects/api/websockets/ ("thousands of clients per instance") | raw |
| C16 | https://developers.cloudflare.com/queues/platform/pricing/ | raw |
| C17 | https://developers.cloudflare.com/workers-ai/platform/pricing/ ; model pages https://developers.cloudflare.com/workers-ai/models/melotts/ (Planned Deprecation 11/20/2026), /aura-1/, /aura-2-en/ | raw |
| C18 | https://developers.cloudflare.com/containers/pricing/ (updated 2026-11-13), https://developers.cloudflare.com/containers/platform-details/limits/ (2026-11-12), https://www.cloudflare.com/products/containers.md ("GPU support (coming soon)"), https://developers.cloudflare.com/changelog/rss/containers.xml | raw |
| C19 | https://developers.cloudflare.com/kv/platform/pricing/ | raw |
| C20 | https://developers.cloudflare.com/pages/platform/limits/ | raw |
| C21 | https://developers.cloudflare.com/k2/ and /k2/platform/pricing/ | raw |
| C22 | https://developers.cloudflare.com/workers/cache/ | raw |
| C23 | https://www.cloudflare.com/service-specific-terms-application-services/ ("Content Delivery Network (Free, Pro, or Business)") | raw |
| C24 | https://blog.partykit.io/posts/hosted-platform-shutdown/ (posted 2026-10-09) | raw |
| C25 | Ably: https://ably.com/docs/platform/pricing.md and /pricing/fair-usage.md; Pusher: https://pusher.com/channels/pricing | raw |
| C26 | Bunny CDN: https://bunny.net/pricing/cdn/ | raw |
| C26b | Cloudflare plans (Pro $20 annual / $25 monthly, Business $200 / $250; CDN rows flat per plan): https://www.cloudflare.com/plans/ | raw |

### LLM

| ID | Source |
|---|---|
| L1 | https://ai.google.dev/gemini-api/docs/pricing (read through the `.md.txt` variant) |
| L2 | https://platform.claude.com/docs/en/about-claude/pricing ; Claude API skill pricing table (cached 2026-10-06) |
| L3 | https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/deprecations |
| L4 | https://api-docs.deepseek.com/quick_start/pricing |
| L5 | https://www.alibabacloud.com/help/en/model-studio/model-pricing |
| L6 | https://docs.mistral.ai/models/ministral-3-8b-25-12 |
| L7 | https://console.groq.com/docs/models |
| L8 | https://deepinfra.com/pricing |
| L9 | https://www.truefoundry.com/blog/vllm-benchmark (A10, Qwen3-8B; secondary) |
| L10 | https://www.databasemart.com/blog/vllm-gpu-benchmark-rtx4090 (secondary) |
| L11 | https://www.cloudrift.ai/blog/benchmarking-rtx-gpus-for-llm-inference (secondary) |
| L12 | https://discuss.vllm.ai/t/sm120-rtx-pro-4000-6-5x-throughput-gain-and-v0-18-1-regression-findings/2525 (anecdotal, 2026-04-03) |

### Audio and browsers

| ID | Source |
|---|---|
| A1 | Apple Safari release notes (fetched as `developer.apple.com/tutorials/data/documentation/safari-release-notes/safari-<ver>-release-notes.md`, human page `developer.apple.com/documentation/safari-release-notes/`): Safari 15, 16.4, 17, 17.4, 17.5, 18.4, 26, 27.0 ("Released September 14, 2026 - 27.0 (20625.1.29)"), 27.2 |
| A2 | Apple, HLS Authoring Specification for Apple Devices: https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html (no occurrence of "opus"; rules 2.1, 7.1, 7.5, 7.7, 8.4, 8.11, 8.12, 8.17, 8.18, 10.1) |
| A3 | Apple Developer Forums, "Does iOS HLS support opus audio?", Apple Media Engineer, accepted answer, Jul 2024: https://developer.apple.com/forums/thread/759210 (quote re-verified 19 Nov 2026) |
| A4 | IETF, HTTP Live Streaming 2nd Edition, draft-pantos-hls-rfc8216bis-22, R. Pantos, Apple, 1 May 2026 (packed audio ID3 PRIV, stale playlist, hold-back) |
| A5 | Apple Developer Forums, "CoreMediaErrorDomain -12888 ...", Apple Systems Engineer, accepted answer, May 2025: https://developer.apple.com/forums/thread/783255 (quote re-verified 19 Nov 2026) |
| A6 | W3C Audio Session draft (13 Nov 2024); WebKit bugs 237322, 261554, 264473, 251532, 291892; third-party report https://github.com/Larront/grimoire/issues/244 (29 Oct 2026, secondary) |
| A7 | MDN browser-compat-data (`api/AudioDecoder.json`, `ManagedMediaSource.json`, `MediaSource.json`, `AudioSession.json`, `MediaSession.json`, `BaseAudioContext.json`), re-read 19 Nov 2026: AudioDecoder Safari 26 / Chrome 94 / Firefox 130; ManagedMediaSource Safari 17 / iOS 17.1; AudioSession Safari 16.4; MediaSession Safari 15 |
| A8 | WebKit blog, "News from WWDC25: Web technology coming this fall in Safari 26 beta": https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ ("adding AudioEncoder and AudioDecoder") |
| A9 | hls.js README (Chrome native HLS unreliable; fMP4 Opus "subject to runtime support"): https://github.com/video-dev/hls.js ; caniuse data (stamped 11 Nov 2026); WebKit Safari 27 feature posts https://webkit.org/blog/18325/webkit-features-for-safari-27-0/ , /18486/ , /18515/ (cited by the audio sub-agent; not opened by me) |

### GPU and CPU compute

| ID | Source |
|---|---|
| G1 | Modal: https://modal.com/pricing (price table re-read raw) and docs (scaledown window, snapshots, concurrency) |
| G2 | RunPod: https://www.runpod.io/pricing ("Updated November 12, 2026"), https://docs.runpod.io/serverless/pricing |
| G3 | Hetzner GPU line: https://www.hetzner.com/dedicated-rootserver/matrix-gpu/ and https://www.hetzner.com/dedicated-rootserver/gex44/ (redirects to the GEX45 page): GEX45 EUR 214/month, EUR 209 setup, EUR 0.3429/h; GEX63 EUR 999; GEX131 from EUR 1,499 (read by me, 19 Nov 2026) |
| G4 | Hetzner AX line: https://www.hetzner.com/dedicated-rootserver/matrix-ax/ (AX41 EUR 59, AX42 EUR 79 + 49 setup, AX102 EUR 159 + 129 setup; read by me) |
| G5 | Replicate https://replicate.com/pricing (raw), fal https://fal.ai/pricing, Baseten https://www.baseten.co/pricing, Beam https://www.beam.cloud/pricing, Koyeb https://www.koyeb.com/pricing, Northflank https://northflank.com/pricing, Lambda https://lambda.com/pricing (via sub-agent; Replicate verified raw) |
| G6 | Cloudflare acquisition of Replicate announced 17 Nov 2025 (secondary: closed early 2026); Mistral AI acquiring Koyeb announced 17 Feb 2026 (secondary) |
| G7 | Vast.ai marketplace prices via third-party trackers (computeprices.com and others; low confidence) |
| G8 | Kokoro source: https://github.com/hexgrad/kokoro (`kokoro/model.py` `Output.pred_dur`; Apache-2.0; last push 2025-08-06; read via GitHub API 19 Nov 2026) |
| G9 | Kokoro GPU RTF tables (secondary; Kokoro-FastAPI "about 35x" on a 4060 Ti is a vendor/community claim) |
| G10 | CPU TTS benchmark, 4 vCPU Intel Xeon Platinum 8272CL, generated 2026-07-06: https://github.com/gauravvij/kokoro-tts-vs-supertonic-3-tts (results/benchmark_report.md); 4 vCPU EPYC 7763 run: https://bittide.aicompass.dev (secondary); 32-core claim: https://ocdevel.com/blog/20260711-quantized-cpu-tts (secondary) |

---

## Appendix B. Probe method, vantage and raw numbers

Vantage: the agent pod on this box; Cloudflare `cf-ray` suffix `-SIN` shows egress near Singapore, HN/Firebase is US-hosted, so per-request latencies (0.5 s per item GET, 2.5 s for a 571 KB Algolia tree) are pessimistic for a US or EU host. Tick cadence and creation-to-visible lags do not depend on vantage. Probe scripts were kept outside this repo (`/tmp/hn-scripts`); data directories were separate and read with `python3 -I`.

| Probe | What it did | Window | n |
|---|---|---|---|
| P1 | SSE on `maxitem`, `updates`, `topstories`; fetch each new `maxitem` item (retry 1,2,... s); Algolia `search_by_date` every 4 s; Algolia `items/<id>` on 1 in 4 comments; `/newcomments` HTML every 31 s (robots.txt `Crawl-delay: 30`) | 18 Nov 19:34 to 19:42 UTC (7 min) | 24 SSE events per stream, 13 items |
| P2 | REST: `maxitem` every 1 s plus `item/<last+1..+3>`; Algolia `search_by_date` every 5 s; `items/<id>` on 1 in 3 comments at 5,10,15,20,30,45,60,90,120 s; `/newcomments` every 31 s | 19:45 to 19:51 UTC (5.5 min) | 60 items, 40 Algolia search first-seens, 17 items-API samples, 9 distinct `maxitem` values |
| P3 | SSE `maxitem` vs REST `maxitem` every 0.5 s | 19:53 to 19:56 UTC (200 s) | 6 ticks |
| P4 | `spikes/firehose/probe.py` by another agent in this repo (read-only use): polls `maxitem` every 2 s, fetches each new id, logs `time`, `fetched`, `fetch_ms`; ranks every 30 s | 19:29 UTC onward, 100 min planned | see section 1.1 |
| P5 | One SSE session on `maxitem` for 25 min (reconnect behaviour) | 20:16 UTC onward | see section 1.1 |
| Q | ClickHouse SQL playground and Algolia day-window counts (queries in section 1.5) | 18 to 19 Nov | n/a |

Website freshness (weak evidence, 11 fetches over 5.5 min): the logged-out `/newcomments` page served the same newest comment for up to 109 s (ages at fetch 16 to 111 s, content changed at 19:46:29 and 19:48:35 UTC), while Firebase already had newer items; response header `Cache-Control: private; max-age=0`. HN appears to serve logged-out pages from a snapshot refreshed roughly every two minutes, so Firebase is fresher than the logged-out HTML.

Reproduce the volume figures: `curl -s 'https://sql-clickhouse.clickhouse.com/?user=demo' --data-binary "SELECT toStartOfMonth(time) m, countIf(type='comment') c, countIf(type='comment' AND dead=0 AND deleted=0) live FROM hackernews.hackernews WHERE time >= '2025-01-01' GROUP BY m ORDER BY m FORMAT TSVWithNames"`.
