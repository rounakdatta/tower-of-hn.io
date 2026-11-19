#!/usr/bin/env python3
"""Ear test: voice one real HN table with several TTS engines, same text.

usage: render.py <engine> <script.json> <out_dir>
engines: kokoro | kitten2-nano | kitten2-mini | gemini

Writes <out_dir>/<engine>.wav (turns joined with short gaps) and
<out_dir>/<engine>.json (per-turn synthesis seconds, audio seconds, RTF).
"""
import json, os, re, sys, time
import numpy as np
import soundfile as sf

# --- the speakability layer, first cut: verbatim words, unspeakable bits mapped ---
LEXICON = {r"\bnginx\b": "engine-x", r"\bNginx\b": "Engine-x", r"\bUB\b": "U.B.", r"\bCVE-": "C.V.E. ", r"\bHN\b": "H.N."}


def speakable(text):
    t = re.sub(r"https?://(?:www\.)?([^/\s]+)\S*", r"(link to \1)", text)
    t = t.replace("`", "")
    t = re.sub(r"^EDIT:", "Edit:", t, flags=re.M)
    for pat, rep in LEXICON.items():
        t = re.sub(pat, rep, t)
    t = re.sub(r"\s*\n\s*\n\s*", "\n", t).strip()
    return t


# Tone tags an LLM would produce; hand-written for the test.
TONE = {
    50547794: ("sarcastic, then sincere", "dry and sarcastic for the first sentence, then sincere and reflective"),
    50548186: ("matter-of-fact", "calm, matter-of-fact, mildly pushing back"),
    50548278: ("explaining", "patient, precise, explaining"),
    50548742: ("thoughtful", "thoughtful, suggesting an idea"),
    50548856: ("concede then correct", "friendly concession, then firmly correcting"),
}

VOICES = {
    "kokoro": ["am_michael", "bf_emma", "am_fenrir"],
    "kitten2": ["Otis", "Serena", "Vincent"],
    "gemini": ["Charon", "Kore", "Puck"],
}


def speaker_slots(turns):
    order = []
    for t in turns:
        if t["by"] not in order:
            order.append(t["by"])
    return {by: i for i, by in enumerate(order)}


def main(engine, script_path, out_dir):
    turns = json.load(open(script_path))
    slots = speaker_slots(turns)
    os.makedirs(out_dir, exist_ok=True)
    if engine == "kokoro":
        from kokoro_onnx import Kokoro
        d = os.path.expanduser("~/.cache/tohn-models")
        k = Kokoro(f"{d}/kokoro-v1.0.onnx", f"{d}/voices-v1.0.bin")
        sr = 24000

        def synth(text, slot, tone):
            audio, rate = k.create(text, voice=VOICES["kokoro"][slot], speed=1.0, lang="en-us")
            return audio, rate
    elif engine.startswith("kitten2"):
        from kittenml import KittenTTS
        m = KittenTTS(f"KittenML/kitten-tts-2-{engine.split('-')[1]}")
        print("voices:", getattr(m, "available_voices", "?"), file=sys.stderr)

        def synth(text, slot, tone):
            return np.asarray(m.generate(text, voice=VOICES["kitten2"][slot])), m.sample_rate
    elif engine == "gemini":
        # Raw REST: the installed google-genai SDK sends a speech config the API now rejects.
        import base64, urllib.request
        model = os.environ.get("GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

        def synth(text, slot, tone):
            prompt = f"Read this Hacker News comment aloud, {tone}. Speak naturally, like a person in a lively conversation:\n\n{text}"
            body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICES["gemini"][slot]}}}}}
            req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
                "x-goog-api-key": os.environ["GEMINI_API_KEY"], "content-type": "application/json"})
            for attempt in range(8):  # free-tier key: a few requests per minute
                try:
                    j = json.load(urllib.request.urlopen(req, timeout=180))
                    break
                except urllib.error.HTTPError as e:
                    if e.code != 429 or attempt == 7:
                        raise
                    time.sleep(70)
            pcm = base64.b64decode(j["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
            return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0, 24000
    else:
        raise SystemExit(f"unknown engine {engine}")

    pieces, report, rate = [], [], None
    for t in turns:
        text = speakable(t["text"])
        tone_short, tone_long = TONE.get(t["id"], ("neutral", "neutral"))
        t0 = time.time()
        audio, rate = synth(text, slots[t["by"]], tone_long)
        dt = time.time() - t0
        secs = len(audio) / rate
        report.append({"id": t["id"], "by": t["by"], "chars": len(text), "synth_s": round(dt, 2), "audio_s": round(secs, 2), "rtf": round(dt / secs, 3) if secs else None})
        gap = 0.35 if pieces else 0.0
        if gap:
            pieces.append(np.zeros(int(rate * gap), dtype=np.float32))
        pieces.append(np.asarray(audio, dtype=np.float32))
        print(json.dumps(report[-1]), file=sys.stderr)
    sf.write(os.path.join(out_dir, f"{engine}.wav"), np.concatenate(pieces), rate)
    json.dump({"engine": engine, "turns": report, "texts": [speakable(t["text"]) for t in turns]}, open(os.path.join(out_dir, f"{engine}.json"), "w"), indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
