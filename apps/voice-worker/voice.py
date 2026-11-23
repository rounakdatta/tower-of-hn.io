#!/usr/bin/env python3
"""Voice worker v0: jobs.jsonl -> tagged, voiced, Opus-encoded comment packs.

usage: voice.py <data_dir> [table_index]

For each comment: an LLM tags its delivery (one call per table, with context),
Kitten-TTS 2 voices it (through KittenML's public demo until we host it),
and we store <data>/c/<id>.ogg plus <data>/c/<id>.json holding the duration
and a 30 fps loudness envelope that drives the character's mouth.
Everything is written once and reused by every viewer.
"""
import json, os, sys, time, urllib.request
import numpy as np
import soundfile as sf

EMOTIONS = ["angry", "contemplative", "excited", "joyful", "mundane", "nervous", "sad", "stern", "surprised", "tender"]
FPS = 30


def tag_table(jobs):
    """One LLM call per table: delivery tag per turn, judged in context."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return {}
    lines = []
    for j in jobs:
        said = " ".join(s.get("text", "") for s in j["segments"] if s["kind"] in ("say", "quote"))[:700]
        lines.append(f'{j["id"]} | {j["by"]}: {said}')
    prompt = ("These are consecutive comments from one Hacker News thread, in reading order. For each, pick how a voice actor "
              f"should deliver it, from exactly this list: {', '.join(EMOTIONS)}. Snark and sarcasm usually read as stern or mundane; "
              "a correction as stern; musing as contemplative; jokes as joyful. Reply with JSON only: {\"<id>\": \"<emotion>\", ...}.\n\n"
              + "\n".join(lines))
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}}
    for model in ("gemini-3.5-flash-lite", "gemini-2.5-flash-lite"):
        try:
            req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                         data=json.dumps(body).encode(), headers={"x-goog-api-key": key, "content-type": "application/json"})
            j = json.load(urllib.request.urlopen(req, timeout=60))
            tags = json.loads(j["candidates"][0]["content"]["parts"][0]["text"])
            return {int(k): v for k, v in tags.items() if v in EMOTIONS} | {"_model": model}
        except Exception as e:  # noqa: BLE001
            print("tagger", model, str(e)[:200], file=sys.stderr)
    return {}


def spoken_text(job, emotion):
    parts = []
    for s in job["segments"]:
        if s["kind"] == "say":
            parts.append(s["text"])
        elif s["kind"] == "quote":
            parts.append(f'Quote: {s["text"]}. End quote.')
        elif s["kind"] == "link":
            parts.append(f'Link: {s["domain"]}.')
        elif s["kind"] == "code":
            parts.append(f'{s["text"]}.')
    text = " ".join(p for p in parts if p).strip()
    return (f"[{emotion}] " if emotion and emotion != "mundane" else "") + text


def chunks(text, limit):
    """Split at sentence ends so no piece exceeds `limit`; a leading [emotion] tag is repeated on every piece."""
    import re
    tag = ""
    m = re.match(r"^(\[[a-z]+\] )", text)
    if m:
        tag, text = m.group(1), text[len(m.group(1)):]
    out, cur = [], ""
    for sent in re.split(r"(?<=[.!?])\s+", text):
        while len(sent) > limit:                      # a monster sentence: cut at a comma or space
            cut = max(sent.rfind(", ", 0, limit), sent.rfind(" ", 0, limit))
            cut = cut if cut > 0 else limit
            out.append(sent[:cut + 1].strip())
            sent = sent[cut + 1:]
        if cur and len(cur) + 1 + len(sent) > limit:
            out.append(cur)
            cur = sent
        else:
            cur = (cur + " " + sent).strip()
    if cur:
        out.append(cur)
    return [tag + c for c in out if c]


def envelope(audio, sr):
    hop = sr // FPS
    n = len(audio) // hop
    rms = np.sqrt(np.mean(audio[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-9)
    env = np.clip((20 * np.log10(rms) + 50) / 40, 0, 1)        # -50..-10 dBFS -> 0..1
    return [int(v * 255) for v in env]


def main(data, table=None):
    from gradio_client import Client
    jobs = [json.loads(l) for l in open(os.path.join(data, "jobs.jsonl"))]
    if table is not None:
        jobs = [j for j in jobs if j["table"] == int(table)]
    os.makedirs(os.path.join(data, "c"), exist_ok=True)
    tags = tag_table(jobs)
    print("tags:", {k: v for k, v in tags.items()}, file=sys.stderr)
    kitten = Client("KittenML/KittenTTS-Demo", verbose=False)
    info = kitten.view_api(return_format="dict", print_info=False)
    voices = [v for v in next(p for p in info["named_endpoints"]["/synthesize"]["parameters"] if p["parameter_name"] == "voice")["type"]["enum"] if v.endswith("_en")]
    for j in jobs:
        pack = os.path.join(data, "c", f'{j["id"]}.json')
        if os.path.exists(pack):
            continue
        emotion = tags.get(j["id"], "mundane")
        text = spoken_text(j, emotion)
        voice = voices[j["voice"] % len(voices)]
        pieces, sr, t0 = [], None, time.time()
        for chunk in chunks(text, 480):
            for attempt in range(12):
                try:
                    r = kitten.predict(chunk, "kitten-tts-2", voice, api_name="/synthesize")
                    wav = r[0] if isinstance(r, (list, tuple)) else r
                    break
                except Exception as e:  # noqa: BLE001
                    print(f'{j["id"]} attempt {attempt}: {str(e)[:120]}', file=sys.stderr)
                    time.sleep(30)
            else:
                raise SystemExit(f'gave up on {j["id"]}')
            a, sr = sf.read(wav, dtype="float32", always_2d=True)
            if pieces:
                pieces.append(np.zeros(int(sr * 0.12), dtype=np.float32))   # a breath between sentences
            pieces.append(a.mean(axis=1))
        audio = np.concatenate(pieces)
        sf.write(os.path.join(data, "c", f'{j["id"]}.ogg'), audio, sr, format="OGG", subtype="OPUS")
        meta = {"id": j["id"], "by": j["by"], "voice": voice, "emotion": emotion, "sr": sr,
                "dur": round(len(audio) / sr, 3), "env": envelope(audio, sr), "text": text}
        json.dump(meta, open(pack, "w"))
        print(json.dumps({k: meta[k] for k in ("id", "by", "voice", "emotion", "dur")}), f"{time.time() - t0:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
