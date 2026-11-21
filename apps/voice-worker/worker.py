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
env:   TTS_ENGINE=kokoro (default, local CPU) | openai (gpt-4o-mini-tts, needs OPENAI_API_KEY;
       each person gets a persistent persona prompt; OPENAI_BUDGET_MIN caps spend, default 300 minutes)
"""
import hashlib, json, os, re, signal, sys, time, urllib.request
import numpy as np
import soundfile as sf

FPS = 30
EMOTIONS = ["angry", "contemplative", "excited", "joyful", "mundane", "nervous", "sad", "stern", "surprised", "tender"]
STANCES = ["agree", "disagree", "correct", "question", "joke", "inform", "expand", "praise"]
CUES = ["question", "uncertain", "joke", "sarcasm", "frustrated", "insult", "praise", "list", "story"]
SPEECH_PACE = float(os.environ.get("PACE", "1.12"))   # everyone talks a little brisker than Kokoro's default
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
            pace = (0.96 + (h32(user, "p") % 1000) / 1000 * 0.1) * SPEECH_PACE
            self.cache[user] = (style.astype(np.float32), lang, pace, f"{a}+{b}@{w:.2f}")
        return self.cache[user]


OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]
AGES = ["in their twenties", "in their thirties", "in their forties", "in their fifties", "in their sixties"]
TIMBRE = ["a warm voice", "a dry voice", "a bright voice", "a slightly husky voice", "a soft voice", "a low, gravelly voice", "a clear, crisp voice"]
PACE = ["a brisk pace", "a measured pace", "an unhurried pace", "a quick, clipped pace"]
ATTITUDE = ["wry", "earnest", "skeptical", "enthusiastic", "deadpan", "thoughtful", "matter-of-fact", "mischievous"]
ACCENT = ["", "", "", "", "", "a light British accent", "a light Australian lilt", "a light Irish lilt", "a light Indian English accent",
          "a light German accent", "a light Scandinavian accent", "a light Canadian accent"]
DELIVERY = {"angry": "with real heat, clipped and forceful", "stern": "firmly, correcting someone, a bit impatient",
            "contemplative": "thinking out loud, with small pauses", "excited": "excited, fast and animated",
            "joyful": "amused, smiling through it, a laugh in the voice", "mundane": "conversationally, relaxed and natural",
            "nervous": "a little unsure, hedging", "sad": "subdued and a bit wistful", "surprised": "genuinely surprised",
            "tender": "gently and kindly"}


def persona(user):
    pick = lambda xs, salt: xs[h32(user, salt) % len(xs)]
    accent = pick(ACCENT, "acc")
    return (pick(OPENAI_VOICES, "voice"),
            f"a {pick(ATTITUDE, 'att')} Hacker News regular {pick(AGES, 'age')}, with {pick(TIMBRE, 'tim')} and {pick(PACE, 'pace')}"
            + (f", and {accent}" if accent else ""))


class OpenAITTS:
    """gpt-4o-mini-tts: character-actor delivery, steered per person and per comment."""

    def __init__(self, key, budget_min):
        self.key, self.budget, self.used = key, budget_min * 60, 0.0

    def create(self, text, who, emotion):
        import io
        if self.used > self.budget:
            raise RuntimeError("OPENAI_BUDGET_MIN reached")
        voice, who_desc = persona(who)
        body = {"model": "gpt-4o-mini-tts", "voice": voice, "input": text, "response_format": "wav",
                "instructions": f"You are {who_desc}. Read this comment you wrote, aloud, as your turn in a lively conversation at a table. "
                                f"Deliver it {DELIVERY.get(emotion, DELIVERY['mundane'])}, at a brisk, natural conversational pace. Sound like a real person talking, not someone reading."}
        req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {self.key}", "content-type": "application/json"})
        data = urllib.request.urlopen(req, timeout=120).read()
        audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)
        self.used += len(audio) / sr
        return audio, sr


def heuristic_tag(text):
    """(emotion, stance, intensity 0..1, cues) without an LLM."""
    t = text.strip()
    low = t.lower()
    caps = len(re.findall(r"\b[A-Z]{3,}\b", t))
    bangs = t.count("!")
    cues = []
    if t.rstrip().endswith("?"):
        cues.append("question")
    if re.search(r"\b(i don't know|not sure|maybe|who knows|no idea|i guess)\b", low):
        cues.append("uncertain")
    if re.search(r"\b(lol|haha|lmao)\b|:\)|😂", low):
        cues.append("joke")
    angry = re.search(r"\b(absurd|ridiculous|nonsense|insane|stupid|idiotic|garbage|bullshit|wtf|outrageous|disgusting)\b", low)
    intensity = min(1.0, 0.25 + 0.15 * bangs + 0.12 * caps + (0.35 if angry else 0))
    if angry or (caps >= 2 and bangs >= 1):
        return "angry", "disagree", max(intensity, 0.7), cues + ["frustrated"]
    if "joke" in cues:
        return "joyful", "joke", intensity, cues
    if "question" in cues or low.startswith(("why ", "how ", "what ", "is ", "does ", "do ", "can ")):
        return "contemplative", "question", intensity, cues
    if low.startswith(("no,", "no.", "not ", "actually", "that's not", "this is wrong", "wrong")):
        return "stern", "correct", max(intensity, 0.5), cues
    if re.search(r"\b(yes|exactly|agreed|great point|this\.|love)\b", low):
        return "joyful", "agree", intensity, cues + ["praise"]
    if bangs >= 2:
        return "excited", "inform", intensity, cues
    return "mundane", "inform", intensity, cues


def llm_tags(batch, key):
    """One call for a table's batch: delivery, stance, intensity and cues per comment, judged in context."""
    lines = []
    for j in batch:
        said = " ".join(s.get("text", "") for s in j["segments"] if s["kind"] in ("say", "quote"))[:600]
        lines.append(f'{j["id"]} | {j["by"]} replying to {j.get("parentBy") or "the story"}: {said}')
    prompt = ("Consecutive comments from one Hacker News thread, about to be performed by actors seated at a table. For each comment, "
              f"judge: e = how the actor should deliver it (one of: {', '.join(EMOTIONS)}); "
              f"s = its stance toward what it replies to (one of: {', '.join(STANCES)}); "
              "i = intensity from 0.0 (flat, neutral) to 1.0 (heated, emphatic, shouting); "
              f"c = any cues that apply (from: {', '.join(CUES)}). "
              "Dry snark is stern or mundane with the sarcasm cue; a correction is stern; musing is contemplative; jokes are joyful. "
              "Use angry only when the writing is genuinely heated (insults, outrage, exasperation), and then give a high intensity. "
              'Reply with JSON only: {"<id>": {"e": "...", "s": "...", "i": 0.0, "c": []}, ...}\n\n' + "\n".join(lines))
    parsed = claude_json(prompt)
    if parsed is not None:
        return parse_tags(parsed)
    if not key:
        return {}
    body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2}}
    for model in ("gemini-3.5-flash-lite", "gemini-2.5-flash-lite"):
        try:
            req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                         data=json.dumps(body).encode(), headers={"x-goog-api-key": key, "content-type": "application/json"})
            j = json.load(urllib.request.urlopen(req, timeout=60))
            return parse_tags(json.loads(j["candidates"][0]["content"]["parts"][0]["text"]))
        except Exception as e:  # noqa: BLE001
            print("tagger", model, str(e)[:160], file=sys.stderr, flush=True)
    return {}


def claude_json(prompt):
    """Claude Haiku for the tags: the Anthropic API when ANTHROPIC_API_KEY is set (production), else the
    in-cluster auth2api gateway (development); None if neither is available."""
    key, url = os.environ.get("ANTHROPIC_API_KEY", ""), "https://api.anthropic.com"
    if not key:
        url = os.environ.get("AUTH2API_URL", "http://auth2api.apps.svc.cluster.local:8317")
        key = os.environ.get("AUTH2API_KEY", "")
        kf = os.path.expanduser("~/.cache/tohn-auth2api.key")
        if not key and os.path.exists(kf):
            key = open(kf).read().strip()
    if not key:
        return None
    url += "/v1/messages"
    # a short classification: no thinking (cheaper, faster; Haiku 5.5 thinks by default otherwise)
    body = {"model": os.environ.get("TAG_MODEL", "claude-haiku-5-5"), "max_tokens": 1500, "thinking": {"type": "disabled"},
            "messages": [{"role": "user", "content": prompt}]}
    try:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={
            "x-api-key": key, "content-type": "application/json", "anthropic-version": "2023-06-01"})
        j = json.load(urllib.request.urlopen(req, timeout=25))
        text = "".join(c.get("text", "") for c in j.get("content", []) if c.get("type") == "text")
        return json.loads(text[text.index("{"): text.rindex("}") + 1])
    except Exception as e:  # noqa: BLE001
        print("tagger claude", str(e)[:160], file=sys.stderr, flush=True)
        return None


def parse_tags(raw):
    out = {}
    for k, v in raw.items():
        if not (isinstance(v, dict) and v.get("e") in EMOTIONS):
            continue
        try:
            cid = int(k)
        except (TypeError, ValueError):
            continue
        try:
            inten = max(0.0, min(1.0, float(v.get("i", 0.4))))
        except (TypeError, ValueError):
            inten = 0.4
        cues = [c for c in (v.get("c") or []) if c in CUES]
        out[cid] = (v["e"], v.get("s") if v.get("s") in STANCES else "inform", inten, cues)
    return out


def sentences(text):
    t = re.sub(r"\b(e\.g|i\.e|vs|etc|cf|Mr|Ms|Dr)\.", lambda m: m.group(0).replace(".", "․"), text)
    return [p.replace("․", ".").strip() for p in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9(\"'])", t) if p.strip()]


def chunk(sents, limit=220, first=None):
    """Sentences packed into clips of <= limit characters; the first clip can be shorter (first words sooner)."""
    full, out, cur = limit, [], ""
    limit = first or full
    for s in sents:
        if out:
            limit = full
        while len(s) > limit:
            cut = max(s.rfind(", ", 0, limit), s.rfind(" ", 0, limit))
            cut = cut if cut > 40 else limit
            if cur:
                out.append(cur)
                cur = ""
            out.append(s[:cut + 1].strip())
            s = s[cut + 1:].strip()
            limit = full
        if cur and len(cur) + 1 + len(s) > limit:
            out.append(cur)
            cur = s
            limit = full
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
            first = None if clips else 110
            spoken, shown = chunk(sentences(s["text"]), first=first), chunk(sentences(s["display"]), first=first)
            if len(spoken) != len(shown):
                shown = spoken
            clips += [(a, b, job["by"]) for a, b in zip(spoken, shown)]
        elif k == "quote":
            who = (job.get("parentBy") or job["by"]) if s.get("of") else job["by"]
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


def resume(live, j, n_plan):
    """A comment that yielded (or whose worker died) part-way carries on from its newest snapshot: the same
    tags and the same clips, so a listener who already heard the start hears the rest in the same voice."""
    for n in range(n_plan - 1, 0, -1):
        try:
            snap = json.load(open(os.path.join(live, f"c/{j['id']}.{j['rev']}.p{n}.json")))
        except Exception:  # noqa: BLE001  (none, or unreadable)
            continue
        if snap.get("next") and all(os.path.exists(os.path.join(live, c["u"])) for c in snap["clips"]):
            return snap
    return None


def job_id(name):
    """<6-digit priority>-<comment id>.json"""
    try:
        return int(name.split("-", 1)[1].split(".", 1)[0])
    except (IndexError, ValueError):
        return None


def klass(prio):
    """How urgent a job is, by towerd's priority bands: 0 someone sat at the table, 1 someone walked onto the
    floor, 2 a floor in focus on the tower, 3 background (openings first, then depth)."""
    return 0 if prio < 100 else 1 if prio < 200 else 2 if prio < 1000 else 3


def urgent(jobs_dir, own=None, mine=10 ** 6):
    """Is someone waiting on something more urgent than this job? Between clips, a job gives way to a more urgent
    band. The comment being voiced doesn't count: towerd renames its job when a listener sits down."""
    pending = sorted(n for n in os.listdir(jobs_dir) if n.endswith(".json") and job_id(n) != own)
    try:
        return bool(pending) and klass(int(pending[0].split("-", 1)[0])) < klass(mine)
    except ValueError:
        return False


class Burst:
    """Listeners get the fast session (FAST_THREADS cores), background work the one-thread one. This VPS takes CPU
    back under sustained multi-core load (steal for every process on it), so bursts are budgeted: at most
    FAST_BUDGET seconds of fast work in any ten minutes."""

    def __init__(self, budget):
        self.budget, self.spans = budget, []

    def ok(self):
        now = time.time()
        self.spans = [(a, b) for a, b in self.spans if b > now - 600]
        return sum(b - max(a, now - 600) for a, b in self.spans) < self.budget

    def spent(self, a, b):
        self.spans.append((a, b))


def main(var):
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))   # PID 1 in a container; every write is atomic
    import onnxruntime as ort
    if os.environ.get("NICE"):
        os.nice(int(os.environ["NICE"]))      # yield the CPU to the node's other work
    from kokoro_onnx import Kokoro
    jobs_dir, live, log = os.path.join(var, "jobs"), os.path.join(var, "live"), os.path.join(var, "voiced.jsonl")
    os.makedirs(os.path.join(live, "c"), exist_ok=True)
    engine = os.environ.get("TTS_ENGINE", "kokoro")
    kokoro = voices = None
    if engine == "kokoro":
        models = os.path.expanduser(os.environ.get("KOKORO_DIR", "~/.cache/tohn-models"))
        # KOKORO_MODEL: kokoro-v1.0.fp16.onnx (default). Measured here on one core: 0.94x real time vs 0.77x for
        # the fp32 original, its weights rounded to half precision (as Kokoro runs on GPUs); int8 drifts further.
        # KOKORO_PROVIDER=cuda runs the same model, and so the same voices, on a GPU (onnxruntime-gpu)
        model = os.environ.get("KOKORO_MODEL", "kokoro-v1.0.fp16.onnx")
        providers = (["CUDAExecutionProvider"] if os.environ.get("KOKORO_PROVIDER") == "cuda" else []) + ["CPUExecutionProvider"]

        def session(threads):
            so = ort.SessionOptions()
            so.intra_op_num_threads = threads
            so.inter_op_num_threads = 1
            so.add_session_config_entry("session.intra_op.allow_spinning", "0")   # idle threads sleep, not spin
            return Kokoro.from_session(ort.InferenceSession(f"{models}/{model}", so, providers=providers), f"{models}/voices-v1.0.bin")
        kokoro = session(1)
        # listeners get three cores (1.81x real time here), so a table never waits on its next line
        fast_n = int(os.environ.get("FAST_THREADS", "3"))
        fast = session(fast_n) if fast_n > 1 else None
        print("kokoro", model, providers[0], "fast threads", fast_n, flush=True)
        voices = Voices(kokoro)
    burst = Burst(float(os.environ.get("FAST_BUDGET", "300")))
    oai = OpenAITTS(os.environ["OPENAI_API_KEY"], float(os.environ.get("OPENAI_BUDGET_MIN", "300"))) if engine == "openai" else None
    key = os.environ.get("GEMINI_API_KEY", "")
    last_llm = 0.0
    print("worker ready", engine, flush=True)
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
            if j["story"] == first["story"]:
                j["_file"] = n
                batch.append(j)
            if len(batch) >= 8:
                break
        # a comment that yielded part-way keeps its tags (resume() reads them back): tag only the rest
        fresh = [j for j in batch if not resume(live, j, len(plan_clips(j)))]
        tags = {}
        if fresh:
            wait = 1 - (time.time() - last_llm)
            if wait > 0:
                time.sleep(wait)
            tags = llm_tags(fresh, key)
            last_llm = time.time()
        for bi, j in enumerate(batch):
            # the batch exists to tag a table's comments in one call; voicing always takes the most urgent job
            # next, so a listener at another table never waits behind the rest of this one
            if bi:
                pending = sorted(n for n in os.listdir(jobs_dir) if n.endswith(".json"))
                if pending and not any(job_id(pending[0]) == b["id"] for b in batch[bi:]):
                    break
            t0 = time.time()
            final = f"c/{j['id']}.{j['rev']}.json"
            if os.path.exists(os.path.join(live, final)):
                # voiced already (a job queued again, or a crash before the log line): say so again, don't redo it
                try:
                    done = json.load(open(os.path.join(live, final)))
                except Exception:  # noqa: BLE001  (unreadable: voice it again below)
                    done = None
                if done is not None:
                    with open(log, "a") as f:
                        f.write(json.dumps({"id": j["id"], "by": j["by"], "path": final, "dur": round(done.get("dur", 0), 2),
                                            "of": len(plan_clips(j)), "voices": sorted({c["who"] for c in done.get("clips", [])})}) + "\n")
                    try:
                        os.remove(os.path.join(jobs_dir, j["_file"]))
                    except FileNotFoundError:
                        pass
                    continue
            emotion, stance, intensity, cues = tags.get(j["id"]) or heuristic_tag(" ".join(s.get("text", "") for s in j["segments"]))
            clips_out, total, dropped, opened, start = [], 0.0, False, False, 0
            plan = plan_clips(j)
            prev = resume(live, j, len(plan))
            if prev:
                emotion, stance, intensity, cues = prev["emotion"], prev["stance"], prev["intensity"], prev["cues"]
                clips_out, total, start = list(prev["clips"]), float(prev["dur"]), int(prev["next"])

            def sidecar(nxt=None):
                return {"id": j["id"], "rev": j["rev"], "by": j["by"], "emotion": emotion, "stance": stance,
                        "intensity": round(intensity, 2), "cues": cues, "dur": round(total, 3), "clips": clips_out,
                        "links": [s for s in j["segments"] if s["kind"] == "link"],
                        "code": [s["code"] for s in j["segments"] if s["kind"] == "code"],
                        **({"partial": True, "of": len(plan), "next": nxt} if nxt is not None else {})}

            for k, (spoken, shown, who) in enumerate(plan):
                if k < start:
                    continue
                # background work (pre-warm, re-voicing) yields between clips to anyone actually listening: a long
                # comment can take a minute, and a table waiting on one line shouldn't. Its job file stays; it
                # resumes from its last snapshot later.
                if k > start and urgent(jobs_dir, own=j["id"], mine=j.get("prio", 10 ** 6)):
                    dropped = True
                    break
                try:
                    if oai:
                        audio, sr = oai.create(spoken, who, emotion)
                    else:
                        style, lang, pace, _ = voices.of(who)
                        speed = pace * SPEED.get(emotion, 1.0) * (0.97 if who != j["by"] else 1.0)
                        quick = fast is not None and klass(j.get("prio", 10 ** 6)) < 3 and burst.ok()
                        c0 = time.time()
                        audio, sr = (fast if quick else kokoro).create(spoken, voice=style, speed=speed, lang=lang, sentence_pause=0.16, clause_pause=0.07)
                        if quick:
                            burst.spent(c0, time.time())
                except Exception as e:  # noqa: BLE001
                    print("tts failed", j["id"], str(e)[:120], file=sys.stderr, flush=True)
                    continue
                audio = np.asarray(audio, dtype=np.float32)
                peak = float(np.abs(audio).max() or 1)
                audio = audio / peak * 0.9
                rel = f"c/{j['id']}.{j['rev']}.{k}.ogg"
                # atomically: a clip is cached as immutable, so nobody may ever read half of one
                sf.write(os.path.join(live, rel + ".tmp"), audio, sr, format="OGG", subtype="OPUS")
                os.replace(os.path.join(live, rel + ".tmp"), os.path.join(live, rel))
                env = envelope(audio, sr)
                shp = shape_track(spoken, env)
                d = len(audio) / sr
                clips_out.append({"u": rel, "d": round(d, 3), "t": shown, "who": who,
                                  "env": [int(v * 255) for v in env], "shape": [int((v + 1) * 127.5) for v in shp]})
                total += d
                if k < len(plan) - 1:
                    # playable so far: an immutable snapshot per clip count, so caches never need busting
                    prel = f"c/{j['id']}.{j['rev']}.p{len(clips_out)}.json"
                    with open(os.path.join(live, prel + ".tmp"), "w") as f:
                        json.dump(sidecar(k + 1), f)
                    os.replace(os.path.join(live, prel + ".tmp"), os.path.join(live, prel))
                    with open(log, "a") as f:
                        f.write(json.dumps({"id": j["id"], "by": j["by"], "path": prel, "dur": round(total, 2), "partial": True,
                                            "of": len(plan), "voices": sorted({c["who"] for c in clips_out})}) + "\n")
                    if j.get("upto") and len(clips_out) >= j["upto"]:
                        opened = True
                        break
            if opened:
                # an opening: its first words are ready for whoever sits down; the rest is voiced on demand
                try:
                    os.remove(os.path.join(jobs_dir, j["_file"]))
                except FileNotFoundError:
                    pass
                print(json.dumps({"id": j["id"], "opened": len(clips_out), "wall_s": round(time.time() - t0, 1)}), flush=True)
                continue
            if dropped:
                print(json.dumps({"id": j["id"], "yielded": True, "after_clips": len(clips_out)}), flush=True)
                break
            side = sidecar()
            rel = final
            tmp = os.path.join(live, rel + ".tmp")
            with open(tmp, "w") as f:
                json.dump(side, f)
            os.replace(tmp, os.path.join(live, rel))
            with open(log, "a") as f:
                f.write(json.dumps({"id": j["id"], "by": j["by"], "path": rel, "dur": round(total, 2),
                                    "of": len(plan), "voices": sorted({c["who"] for c in clips_out})}) + "\n")
            try:
                os.remove(os.path.join(jobs_dir, j["_file"]))
            except FileNotFoundError:
                pass
            print(json.dumps({"id": j["id"], "by": j["by"], "emotion": emotion, "stance": stance, "i": round(intensity, 2), "cues": cues, "clips": len(clips_out),
                              "audio_s": round(total, 1), "wall_s": round(time.time() - t0, 1),
                              "voice": voices.of(j["by"])[3] if voices else persona(j["by"])[0]}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
