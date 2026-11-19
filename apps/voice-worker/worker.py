#!/usr/bin/env python3
"""TowerOfHan voice worker (local first cut).

Watches <var>/jobs for comment jobs written by towerd, and for each comment:
  1. tags delivery per sentence-chunk context (one LLM call per table batch; heuristic fallback),
  2. voices it with Kokoro in a voice that belongs to that person forever (a deterministic
     blend of two built-in voices), one clip per sentence-chunk (<= ~12 s) so playback can
     start after the first sentence; a quote of the parent is voiced by the parent,
  3. writes clips (Ogg Opus) + a sidecar (text, emotion, per-clip loudness + mouth-shape
     tracks at 30 fps) under <var>/live/c/, and appends a line to <var>/voiced.jsonl.

One CPU thread on purpose: this box throttles sustained multi-core load.
usage: worker.py <var dir>
"""
import hashlib, json, os, re, sys, time, urllib.request
import numpy as np
import soundfile as sf

FPS = 30
EMOTIONS = ["angry", "contemplative", "excited", "joyful", "mundane", "nervous", "sad", "stern", "surprised", "tender"]
STANCES = ["agree", "disagree", "correct", "question", "joke", "inform", "expand", "praise"]
SPEED = {"excited": 1.07, "joyful": 1.04, "angry": 1.05, "nervous": 1.08, "surprised": 1.04,
         "contemplative": 0.95, "sad": 0.93, "tender": 0.95, "stern": 0.99, "mundane": 1.0}
FEMALE = ["af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river",
          "af_sarah", "af_sky", "bf_alice", "bf_emma", "bf_isabella", "bf_lily"]
MALE = ["am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck",
        "bm_daniel", "bm_fable", "bm_george", "bm_lewis"]


def h32(s, salt=""):
    return int.from_bytes(hashlib.sha256((salt + s).encode()).digest()[:4], "big")


class Voices:
    """A person's voice: a fixed blend of two same-gender Kokoro voices, derived from their name."""

    def __init__(self, kokoro):
        self.k, self.cache = kokoro, {}

    def of(self, user):
        if user not in self.cache:
            pool = FEMALE if h32(user, "g") % 2 else MALE
            a = pool[h32(user, "a") % len(pool)]
            rest = [v for v in pool if v != a]
            b = rest[h32(user, "b") % len(rest)]
            w = 0.55 + (h32(user, "w") % 1000) / 1000 * 0.35
            style = self.k.get_voice_style(a) * w + self.k.get_voice_style(b) * (1 - w)
            lang = "en-gb" if a.startswith("b") else "en-us"
            pace = 0.96 + (h32(user, "p") % 1000) / 1000 * 0.1
            self.cache[user] = (style.astype(np.float32), lang, pace, f"{a}+{b}@{w:.2f}")
        return self.cache[user]


def heuristic_tag(text):
    t = text.strip()
    low = t.lower()
    if re.search(r"\b(lol|haha|lmao|:\)|😂)", low):
        return "joyful", "joke"
    if t.endswith("?") or low.startswith(("why ", "how ", "what ", "is ", "does ", "do ", "can ")):
        return "contemplative", "question"
    if low.startswith(("no,", "no.", "not ", "actually", "that's not", "this is wrong", "wrong")):
        return "stern", "correct"
    if re.search(r"\b(yes|exactly|agreed|this\.|great|love)\b", low):
        return "joyful", "agree"
    if t.count("!") >= 2:
        return "excited", "inform"
    return "mundane", "inform"


def llm_tags(batch, key):
    """One call for a table's batch: delivery + stance per comment, judged in context."""
    if not key:
        return {}
    lines = []
    for j in batch:
        said = " ".join(s.get("text", "") for s in j["segments"] if s["kind"] in ("say", "quote"))[:600]
        lines.append(f'{j["id"]} | {j["by"]} replying to {j.get("parentBy") or "the story"}: {said}')
    prompt = ("Consecutive comments from one Hacker News thread. For each, choose how a voice actor should deliver it "
              f"(emotion, one of: {', '.join(EMOTIONS)}) and its stance toward what it replies to (one of: {', '.join(STANCES)}). "
              "Dry snark reads as stern or mundane, a correction as stern, musing as contemplative, jokes as joyful. "
              'Reply with JSON only: {"<id>": ["<emotion>", "<stance>"], ...}\n\n' + "\n".join(lines))
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}}
    for model in ("gemini-3.5-flash-lite", "gemini-2.5-flash-lite"):
        try:
            req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                         data=json.dumps(body).encode(), headers={"x-goog-api-key": key, "content-type": "application/json"})
            j = json.load(urllib.request.urlopen(req, timeout=60))
            raw = json.loads(j["candidates"][0]["content"]["parts"][0]["text"])
            out = {}
            for k, v in raw.items():
                if isinstance(v, list) and len(v) == 2 and v[0] in EMOTIONS:
                    out[int(k)] = (v[0], v[1] if v[1] in STANCES else "inform")
            return out
        except Exception as e:  # noqa: BLE001
            print("tagger", model, str(e)[:160], file=sys.stderr, flush=True)
    return {}


def sentences(text):
    t = re.sub(r"\b(e\.g|i\.e|vs|etc|cf|Mr|Ms|Dr)\.", lambda m: m.group(0).replace(".", "․"), text)
    return [p.replace("․", ".").strip() for p in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9(\"'])", t) if p.strip()]


def chunk(sents, limit=220):
    out, cur = [], ""
    for s in sents:
        while len(s) > limit:
            cut = max(s.rfind(", ", 0, limit), s.rfind(" ", 0, limit))
            cut = cut if cut > 40 else limit
            if cur:
                out.append(cur)
                cur = ""
            out.append(s[:cut + 1].strip())
            s = s[cut + 1:].strip()
        if cur and len(cur) + 1 + len(s) > limit:
            out.append(cur)
            cur = s
        else:
            cur = (cur + " " + s).strip()
    if cur:
        out.append(cur)
    return out


def plan_clips(job):
    """[(spoken text, display text, who)] in order; quotes of the parent are spoken by the parent."""
    clips = []
    for s in job["segments"]:
        k = s["kind"]
        if k == "say":
            spoken, shown = chunk(sentences(s["text"])), chunk(sentences(s["display"]))
            if len(spoken) != len(shown):
                shown = spoken
            clips += [(a, b, job["by"]) for a, b in zip(spoken, shown)]
        elif k == "quote":
            who = job.get("parentBy") if s.get("of") else job["by"]
            for a in chunk(sentences(s["text"])):
                clips.append((a, "“" + a + "”", who or job["by"]))
        elif k == "link":
            clips.append((f"Link: {s['domain']}.", s["url"], job["by"]))
        elif k == "code":
            clips.append((f"Here's {s['text']}.", s["code"][:300], job["by"]))
    return [c for c in clips if c[0].strip()]


def envelope(a, sr):
    hop = sr // FPS
    n = max(1, len(a) // hop)
    rms = np.sqrt(np.mean(a[: n * hop].reshape(n, hop) ** 2, axis=1) + 1e-9)
    return np.clip((20 * np.log10(rms) + 50) / 38, 0, 1)


def shape_track(text, env):
    """Mouth roundness (+) vs width (-) per frame: vowels spread over the voiced frames."""
    vowels = [c for c in text.lower() if c in "aeiouwy"]
    voiced = np.where(env > 0.25)[0]
    out = np.zeros(len(env))
    if len(vowels) and len(voiced):
        val = {"o": 1.0, "u": 1.0, "w": 0.8, "e": -0.7, "i": -1.0, "y": -0.8, "a": 0.0}
        idx = np.linspace(0, len(vowels) - 1, len(voiced)).round().astype(int)
        out[voiced] = [val[vowels[i]] for i in idx]
        out = np.convolve(out, np.ones(3) / 3, mode="same")
    return out


def main(var):
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    jobs_dir, live, log = os.path.join(var, "jobs"), os.path.join(var, "live"), os.path.join(var, "voiced.jsonl")
    os.makedirs(os.path.join(live, "c"), exist_ok=True)
    models = os.path.expanduser("~/.cache/tohn-models")
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(f"{models}/kokoro-v1.0.onnx", so, providers=["CPUExecutionProvider"])
    kokoro = Kokoro.from_session(sess, f"{models}/voices-v1.0.bin")
    voices = Voices(kokoro)
    key = os.environ.get("GEMINI_API_KEY", "")
    last_llm = 0.0
    print("worker ready", flush=True)
    while True:
        names = sorted(n for n in os.listdir(jobs_dir) if n.endswith(".json")) if os.path.isdir(jobs_dir) else []
        if not names:
            time.sleep(0.5)
            continue
        try:
            first = json.load(open(os.path.join(jobs_dir, names[0])))
        except Exception:  # noqa: BLE001  (half-written; next loop)
            time.sleep(0.2)
            continue
        # batch: up to 8 waiting jobs from the same table, for one tagging call with context
        batch = []
        for n in names[:40]:
            try:
                j = json.load(open(os.path.join(jobs_dir, n)))
            except Exception:  # noqa: BLE001
                continue
            if j["story"] == first["story"] and j["table"] == first["table"]:
                j["_file"] = n
                batch.append(j)
            if len(batch) >= 8:
                break
        wait = 4 - (time.time() - last_llm)
        if key and wait > 0:
            time.sleep(wait)
        tags = llm_tags(batch, key) if key else {}
        last_llm = time.time()
        for j in batch:
            t0 = time.time()
            emotion, stance = tags.get(j["id"]) or heuristic_tag(" ".join(s.get("text", "") for s in j["segments"]))
            clips_out, total = [], 0.0
            for k, (spoken, shown, who) in enumerate(plan_clips(j)):
                style, lang, pace, _ = voices.of(who)
                speed = pace * SPEED.get(emotion, 1.0) * (0.97 if who != j["by"] else 1.0)
                try:
                    audio, sr = kokoro.create(spoken, voice=style, speed=speed, lang=lang)
                except Exception as e:  # noqa: BLE001
                    print("tts failed", j["id"], str(e)[:120], file=sys.stderr, flush=True)
                    continue
                audio = np.asarray(audio, dtype=np.float32)
                peak = float(np.abs(audio).max() or 1)
                audio = audio / peak * 0.9
                rel = f"c/{j['id']}.{j['rev']}.{k}.ogg"
                sf.write(os.path.join(live, rel), audio, sr, format="OGG", subtype="OPUS")
                env = envelope(audio, sr)
                shp = shape_track(spoken, env)
                d = len(audio) / sr
                clips_out.append({"u": rel, "d": round(d, 3), "t": shown, "who": who,
                                  "env": [int(v * 255) for v in env], "shape": [int((v + 1) * 127.5) for v in shp]})
                total += d
            side = {"id": j["id"], "rev": j["rev"], "by": j["by"], "emotion": emotion, "stance": stance,
                    "dur": round(total, 3), "clips": clips_out,
                    "links": [s for s in j["segments"] if s["kind"] == "link"],
                    "code": [s["code"] for s in j["segments"] if s["kind"] == "code"]}
            rel = f"c/{j['id']}.{j['rev']}.json"
            tmp = os.path.join(live, rel + ".tmp")
            json.dump(side, open(tmp, "w"))
            os.replace(tmp, os.path.join(live, rel))
            with open(log, "a") as f:
                f.write(json.dumps({"id": j["id"], "path": rel, "dur": round(total, 2)}) + "\n")
            try:
                os.remove(os.path.join(jobs_dir, j["_file"]))
            except FileNotFoundError:
                pass
            print(json.dumps({"id": j["id"], "by": j["by"], "emotion": emotion, "stance": stance, "clips": len(clips_out),
                              "audio_s": round(total, 1), "wall_s": round(time.time() - t0, 1), "voice": voices.of(j["by"])[3]}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
