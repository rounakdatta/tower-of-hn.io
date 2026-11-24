#!/usr/bin/env bash
# Run Tower of HN locally: towerd (live HN -> files, and the voice queue on :8788), a voice runner, and the 3D client.
#   scripts/dev.sh                 Kokoro voices, one lane on one CPU thread (free); LANES=2 THREADS=2 for more
#   TTS_ENGINE=openai OPENAI_API_KEY=sk-... scripts/dev.sh     character-actor voices (gpt-4o-mini-tts)
# Emotion tags come from Claude Haiku through towerd (AUTH2API_KEY or ANTHROPIC_API_KEY); without one, runners judge
# from the words.
# Open http://127.0.0.1:5288 (a WebGPU browser: Chrome, Edge, Safari 26+).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p var
[ "${TTS_ENGINE:-kokoro}" = kokoro ] && scripts/fetch-models.sh >/dev/null
node apps/towerd/src/main.ts > var/towerd.log 2>&1 &
TOWERD=$!
PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1 LANES=${LANES:-1} THREADS=${THREADS:-1} python3 apps/voice-worker/worker.py > var/worker.log 2>&1 &
WORKER=$!
trap 'kill $TOWERD $WORKER 2>/dev/null' EXIT
echo "towerd pid $TOWERD (var/towerd.log), voice runner pid $WORKER (var/worker.log)"
cd apps/client && npm install --no-audit --no-fund --loglevel=error && npx vite --host 127.0.0.1 --port 5288 --strictPort
