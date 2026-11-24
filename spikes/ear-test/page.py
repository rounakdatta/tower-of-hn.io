#!/usr/bin/env python3
"""Build the listening page: Opus copies of every render + one static HTML file.

usage: page.py <out_dir> <site_dir>
Engine notes live in NOTES below; anything not rendered is skipped.
"""
import html, json, os, sys
import numpy as np
import soundfile as sf

NOTES = {  # engine: (display name, how it ran, what it would cost us)
    "kitten2-big": ("Kitten-TTS 2 (1.7B)", "open weights (Apache-2.0) · via KittenML's demo GPU · emotion tags on", "self-host on a GPU"),
    "gemini": ("Gemini 2.5 Flash TTS", "Google API · tone given as a prompt", "API, per token"),
    "qwen3": ("Qwen3-TTS 1.7B", "open weights · via Qwen's demo · tone given as an instruction", "self-host on a GPU"),
    "chatterbox-turbo": ("Chatterbox Turbo", "open weights (MIT) · via Resemble's demo · cloned from synthetic voices", "self-host on a GPU"),
    "higgs": ("Higgs Audio v2", "open weights · via a community demo", "self-host on a GPU"),
    "kokoro": ("Kokoro 82M", "open weights (Apache-2.0) · ran HERE on 2 CPU threads", "runs on CPU"),
    "kitten2-mini": ("Kitten-TTS 2 mini (82M)", "open weights · ran HERE on 2 CPU threads", "runs on CPU"),
    "kitten2-nano": ("Kitten-TTS 2 nano (17M)", "open weights · ran HERE on 2 CPU threads", "runs on CPU, even in a browser"),
}


def main(out_dir, site):
    os.makedirs(os.path.join(site, "audio"), exist_ok=True)
    script = json.load(open(os.path.join(os.path.dirname(__file__), "script.json")))
    cards = []
    for eng, (name, how, cost) in NOTES.items():
        wav = os.path.join(out_dir, f"{eng}.wav")
        if not os.path.exists(wav):
            continue
        a, sr = sf.read(wav, dtype="float32", always_2d=True)
        a = a.mean(axis=1)
        if sr not in (8000, 12000, 16000, 24000, 48000):  # Opus rates
            idx = np.linspace(0, len(a) - 1, int(len(a) * 24000 / sr))
            a, sr = np.interp(idx, np.arange(len(a)), a).astype(np.float32), 24000
        a = a / max(1e-6, np.abs(a).max()) * 0.89  # same loudness ceiling for a fair listen
        opus = os.path.join(site, "audio", f"{eng}.ogg")
        sf.write(opus, a, sr, format="OGG", subtype="OPUS")
        rep = json.load(open(os.path.join(out_dir, f"{eng}.json")))
        secs = sum(t.get("audio_s", 0) for t in rep["turns"])
        speed = ""
        synth = [t.get("synth_s") for t in rep["turns"] if t.get("synth_s")]
        if synth:
            speed = f"{secs / sum(synth):.1f}× realtime here"
        cards.append(f"""<section><h2>{html.escape(name)}</h2><p class=m>{html.escape(how)}{(' · ' + speed) if speed else ''}</p>
<audio controls preload=none src="audio/{eng}.ogg"></audio><p class=m>{secs:.0f} s · {os.path.getsize(opus) // 1024} KB as Opus</p></section>""")
    feat = ""
    fj = os.path.join(site, "table-e2e.json")
    if os.path.exists(fj):
        t = json.load(open(fj))
        cast = "".join(f"<li><b>{html.escape(x['by'])}</b> · voice {html.escape(x['voice'].replace('_en', '').title())} · {html.escape(x['emotion'])} · {x['dur']:.0f} s</li>" for x in t["turns"])
        feat = f"""<section><h2>The whole pipeline, on tonight's #1 table</h2><p class=m>{html.escape(t['story']['title'])} · 14 turns, 9 people, about 5 minutes.
Live HN → speakability layer → an LLM picks each turn's delivery → Kitten-TTS 2, one voice per person → Opus. Nothing hand-edited.</p>
<audio controls preload=none src="audio/table-e2e.ogg"></audio><details><summary>Cast and delivery, in order</summary><ol>{cast}</ol></details></section>"""
    turns = "".join(f"<p><b>{html.escape(t['by'])}</b> {html.escape(t['text'])}</p>" for t in script)
    page = f"""<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Tower of HN — ear test</title><style>
body{{margin:0 auto;max-width:640px;padding:20px 18px 60px;background:#0f1117;color:#e9e6e0;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}}
h1{{font-size:22px;margin:8px 0 4px}}h2{{font-size:17px;margin:0 0 2px}}.m{{color:#9aa1b2;font-size:13px;margin:2px 0 8px}}
section{{border-top:1px solid #262a36;padding:16px 0}}audio{{width:100%}}b{{color:#ff9a3c}}details p{{margin:0 0 10px}}a{{color:#9ab8ff}}
</style><h1>Ear test</h1>
<p class=m>Headphones on. First, tonight's #1 HN thread as the whole pipeline voiced it. Then five engines reading the same five comments
(<a href="https://news.ycombinator.com/item?id=50547794">Nginx RCE thread</a>, three people, verbatim): does it sound like people talking to each other?
Listen for the snark in the first line, and "nginx", "UB", "CVE", "Rust". Qwen3-TTS, Chatterbox Turbo and Higgs Audio v2 ran out of free demo GPU; they join the proper bake-off.</p>
{feat}<section><h2 style='margin-bottom:0'>Same five comments, five engines</h2></section>{''.join(cards)}
<section><details><summary>The text, as spoken</summary>{turns}</details></section></html>"""
    open(os.path.join(site, "index.html"), "w").write(page)
    print("wrote", len(cards), "engines")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
