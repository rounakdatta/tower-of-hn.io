# Deploying TowerOfHan to the homelab

Written 20 Nov 2026. Prices were read on the day; sources are listed at the end.

## The short answer

**About $10–25 a month and three to four days of work.** That's far below the $263/month in PLAN.md §10, because the homelab replaces the Workers plan and the rented GPU box.

| | Monthly | Notes |
|---|---|---|
| Hosting (towerd, client, one-thread voice worker) | $0 | Already paid for: the homelab. |
| Claude Haiku 5.5 for emotion tags | ≈ $9 | About 5,000 comments a day × ~300 in / 60 out tokens, at $0.10 / $0.50 per M. Thinking off or low effort. Use a real API key, not the personal plan through auth2api, once the service is public. |
| R2 for audio, behind Cloudflare | ≈ $0.2–2 | About 78 KB per comment (measured: Opus at ~36 kbps plus its sidecar), so ~12 GB of new audio a month if every front-page comment is voiced. $0.015/GB-month (the account's 10 GB free tier is already used by backups); egress is free. Keep ~30 days. |
| GPU voicing on Modal (optional, for full coverage at peak) | ≈ $0–15 | The same Kokoro code on a T4 at $0.59/h, scaling to zero. ~22 h of speech a day ≈ 1–2 GPU-hours ≈ $20–40, minus Modal's $30 monthly credit. |
| Domain | ≈ $1–4 | Both are unregistered today (RDAP 404). towerofhan.com: $11.81/yr at Porkbun. towerofhan.io: $28.12 the first year, $51.80/yr after. Or free: towerofhan.taptappers.club. |
| **Total** | **≈ $10–25** | |

## What the homelab can and can't do

- **Voicing is the only thing the server can't fully carry.**
  - Kokoro runs at 0.7× real time on one thread (int8: 0.87×, fp16: 0.83×). One thread covers roughly 75% of an average day's front page: every table a listener sits at first, then the best tables of the top floors.
  - At US daytime peaks it falls behind. With streaming (shipped today), a listener still hears a comment's first words within seconds; long comments may pause between sentences.
  - Two or more busy threads raise CPU steal for the whole VM, k3s and etcd included. So the worker stays at one thread, and full coverage needs a GPU somewhere else.
- **Memory.** The worker uses 866 MB with the full model and towerd 147 MB, against about 2 GB free on kanmani (6 Nov). Use the int8 model there (`KOKORO_MODEL=kokoro-v1.0.int8.onnx`, about 0.6 GB), or re-check headroom first.
- **Bandwidth isn't a problem.**
  - The client is 263 KB gzipped, and a listener streams about 4.5 KB/s.
  - Everything except `head.json` is immutable and cached at Cloudflare, so the origin barely notices a Show HN spike.
  - Cloudflare's terms want media served through a paid product such as R2, not proxied from an origin on the free plan. Hence audio on R2 behind a custom domain, and JSON/HTML through the proxied origin.
- **Browsers.**
  - WebGPU where available, with three.js's WebGL2 fallback otherwise. That fallback was verified today: full scene, no errors.
  - Still to test on your iPhone: Ogg Opus decoding in Safari. If it fails, add AAC, as PLAN.md planned.
  - Phone frame rate is still unknown; test it during the private phase.

## Voices on a GPU: why our own worker, not an API

Every person's voice is a weighted blend of two Kokoro voices plus their own speed:

| Option | Weighted blends | Speed | Opus/AAC | Price | Verdict |
|---|---|---|---|---|---|
| Our worker on Modal/RunPod (onnxruntime-gpu) | ✓ identical | ✓ | ✓ | ≈ $20–40/mo before credits | **Recommended.** Same code, same voices. `KOKORO_PROVIDER=cuda` is already in the worker. |
| Kokoro-FastAPI, self-hosted | ✓ (`af_bella(7)+af_sky(3)`) | ✓ | ✓ | GPU time, same as above | Fine too, but adds a second codebase. |
| Together AI | ✓ (decimal weights) | ✗ | ✗ (mp3/wav) | $4.00/M chars ≈ $210/mo for everything | Loses per-person speed; needs a transcode. |
| DeepInfra | ✗ (equal mixes only) | ✓ | ✓ | $0.99/M chars ≈ $52/mo | Voices would change. |
| deAPI, Venice, fal, Replicate, OpenRouter | ✗ | some | some | $0.77–20/M | Voices would change. |

## The work

1. **Package (½ day).**
   - CI in this repo builds two images to GHCR: towerd, which also serves the client build, and the voice worker, with the models baked in or fetched on start.
   - No Docker on agentfest: the builds happen in CI.
2. **Homelab, private first (½ day).**
   - `homelab.setup/kubernetes/apps/towerofhan`: one pod in which towerd and the worker share a volume (they talk through files today), plus a Service and an Ingress on the **tailnet** door.
   - Add the DNS record in oh-my-dns.
   - Put the Anthropic key (and later the R2 keys) in Bitwarden, synced to Secrets.
   - No CPU requests (the scheduler is full); the worker stays on one thread.
   - Deploy the branch with `deploy-stuff.yml --ref`, then merge.
   - Then open it on your phone and laptop over Tailscale.
3. **Production hardening (1 day).**
   - The worker writes clips to R2.
   - Cloudflare cache rules: cache `/live/*`, give `head.json` a 1–2 s TTL.
   - Retention: drop audio for stories off the front page for more than 30 days.
   - When HN deletes or kills a comment, remove its audio.
   - Rate-limit `POST /want`.
   - A short about page with an opt-out ("don't voice me").
   - Point nightwatch at it.
4. **Public (¼ day).**
   - Ingress to the `websecure` door; proxied DNS record; real domain if wanted.
   - It joins the deliberately-public list (itineris, eie…). Its surface is small: static files, read-only JSON, one POST that can only queue voicing of real front-page comments.
5. **GPU voicing (1 day, optional).**
   - towerd exposes the job queue over authenticated HTTPS.
   - A Modal function runs the same worker on CUDA. It wakes when the queue is non-empty, drains it into R2, then scales to zero.
   - The homelab thread stays as the fallback.
6. **Before Show HN.**
   - A courtesy note to HN's moderators. Comments are read verbatim and attributed, deletions are honoured, and there's an opt-out.
   - A budget alert on Modal and Anthropic.

## Sources (read 20 Nov 2026)
- Modal pricing: https://modal.com/pricing (T4 $0.000164/s, $30/month free credits on Starter)
- RunPod serverless: https://www.runpod.io/pricing (16 GB tier $0.58/h, flex per second)
- Kokoro-FastAPI README: https://github.com/remsky/Kokoro-FastAPI (blends, speed, opus/aac; 35–100× real time on a 4060 Ti)
- Together AI TTS: https://docs.together.ai/docs/text-to-speech (weighted Kokoro blends) and https://www.together.ai/pricing ($4/M chars)
- DeepInfra Kokoro: https://deepinfra.com/hexgrad/Kokoro-82M ($0.99/M chars; `preset_voice` array without weights)
- R2 pricing and public buckets: https://developers.cloudflare.com/r2/pricing/ and https://developers.cloudflare.com/r2/buckets/public-buckets/
- Cloudflare service-specific terms (CDN and large files): https://www.cloudflare.com/service-specific-terms-application-services/
- Porkbun pricing API (.com $11.81; .io $28.12 → $51.80); RDAP for towerofhan.com and .io (both 404 = unregistered)
- Claude Haiku 5.5: $0.10 / $0.50 per M tokens (Anthropic API pricing)
- Measured here: one-thread Kokoro speeds, worker memory, 78 KB per comment, 16.1 s average speech, the 263 KB client, and the WebGL2 fallback
