#!/usr/bin/env python3
"""Ear test, part 2: big open models through their public Hugging Face demos.

usage: spaces.py <engine> <script.json> <out_dir>
engines: kitten2-big | voxtral | qwen3 | chatterbox-turbo | higgs

Same text and tone tags as render.py. Cloning engines clone SYNTHETIC
voices (Kokoro clips from out/kokoro-ref-*.wav), never real people.
"""
import json, os, sys, time
import numpy as np
import soundfile as sf
from gradio_client import Client, handle_file

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from render import speakable, TONE, speaker_slots  # noqa: E402

KITTEN_VOICES = ["dante_en", "claire_en", "miles_en"]
KITTEN_TAGS = {50547794: "[contemplative] ", 50548186: "[mundane] ", 50548278: "", 50548742: "[contemplative] ", 50548856: "[stern] "}
VOXTRAL = {  # speaker slot -> (voice, per-comment emotion clip)
    50547794: "EN - Jane, Sarcasm", 50548186: "EN - Paul, Neutral", 50548278: "EN - Jane, Confident",
    50548742: "EN - Oliver, Curious", 50548856: "EN - Jane, Confident"}
QWEN_SPEAKERS = ["Ryan", "Serena", "Aiden"]
HIGGS_PRESETS = ["en_man", "belinda", "chadwick"]


def load(path):
    a, sr = sf.read(path, dtype="float32", always_2d=True)
    return a.mean(axis=1), sr


def main(engine, script_path, out_dir):
    turns = json.load(open(script_path))
    slots = speaker_slots(turns)
    space = {"kitten2-big": "KittenML/KittenTTS-Demo", "voxtral": "mistralai/voxtral-tts-demo", "qwen3": "Qwen/Qwen3-TTS",
             "chatterbox-turbo": "ResembleAI/chatterbox-turbo-demo", "higgs": "smola/higgs_audio_v2"}[engine]
    c = Client(space, verbose=False)
    refs = {i: os.path.join(out_dir, f"kokoro-ref-{i}.wav") for i in range(3)}

    def synth(t, slot):
        text = speakable(t["text"])
        tone = TONE.get(t["id"], ("neutral", "neutral"))[1]
        if engine == "kitten2-big":
            r = c.predict(KITTEN_TAGS.get(t["id"], "") + text, "kitten-tts-2", KITTEN_VOICES[slot], api_name="/synthesize")
            print("kitten:", r[1] if isinstance(r, (list, tuple)) else "", file=sys.stderr)
            return r[0] if isinstance(r, (list, tuple)) else r
        if engine == "voxtral":
            return c.predict(text, VOXTRAL[t["id"]], api_name="/gradio_tts")
        if engine == "qwen3":
            r = c.predict(text, "English", QWEN_SPEAKERS[slot], f"Speak {tone}, like a person in a lively online debate.", "1.7B", api_name="/generate_custom_voice")
            return r[0]
        if engine == "chatterbox-turbo":
            return c.predict(text, handle_file(refs[slot]), 0.8, 0, 0.0, 0.95, 1000, 1.2, True, api_name="/generate")
        if engine == "higgs":
            r = c.predict(text, HIGGS_PRESETS[slot], None, None, 2048, 1.0, 0.95, 50, "Generate audio following instruction.",
                          {"headers": ["stops"], "data": [["<|end_of_text|>"], ["<|eot_id|>"]], "metadata": None}, 7, 2, api_name="/generate_speech")
            return r[1]
        raise SystemExit(engine)

    pieces, report, rate = [], [], None
    for t in turns:
        t0 = time.time()
        cached = os.path.join(out_dir, "turns", f"{engine}-{t['id']}.wav")
        os.makedirs(os.path.dirname(cached), exist_ok=True)
        for attempt in range(3):
            if os.path.exists(cached):
                path = cached
                break
            try:
                path = synth(t, slots[t["by"]])
                a_, sr_ = load(path)
                sf.write(cached, a_, sr_)
                break
            except Exception as e:  # noqa: BLE001
                print(f"attempt {attempt}: {str(e)[:300]}", file=sys.stderr)
                if attempt == 2:
                    raise
                time.sleep(20)
        dt = time.time() - t0
        audio, sr = load(path)
        if rate and sr != rate:
            raise SystemExit(f"sample rate changed {rate}->{sr}")
        rate = sr
        secs = len(audio) / sr
        report.append({"id": t["id"], "by": t["by"], "wall_s": round(dt, 2), "audio_s": round(secs, 2)})
        print(json.dumps(report[-1]), file=sys.stderr)
        if pieces:
            pieces.append(np.zeros(int(sr * 0.35), dtype=np.float32))
        pieces.append(audio)
    sf.write(os.path.join(out_dir, f"{engine}.wav"), np.concatenate(pieces), rate)
    json.dump({"engine": engine, "space": space, "turns": report}, open(os.path.join(out_dir, f"{engine}.json"), "w"), indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
