#!/usr/bin/env python3
"""Tower of HN voice runner.

towerd (beside the data) plans what to voice; runners on any node voice it. A runner claims one comment at a time over
towerd's internal port (a long poll), voices it with Kokoro in a voice that belongs to that person forever (a
deterministic blend of two built-in voices), one clip per sentence-chunk (<= ~12 s) so playback can start after the
first sentence (a quote of the parent is voiced by the parent), and sends each clip (Ogg Opus, with per-clip loudness
and mouth-shape tracks at 30 fps) the moment it's made: towerd writes it, and the floor hears of it at once.
While voicing it beats once a second; if someone is waiting on something more urgent that nobody else can take,
towerd says yield and it gives way mid-clip (the comment resumes later from its last clip, in the same voice).

A runner is LANES processes, each with its own Kokoro session on THREADS cores (default: two cores a lane, as many
lanes as the cores it may use). It needs no volume, no keys and no internet: only towerd's voice port.

usage: worker.py
env:   VOICE_URL (default http://127.0.0.1:8788), VOICE_TOKEN, LANES (or MAX_LANES, default 4), THREADS, PATIENCE (a standby:
       it takes nothing while any other runner has been heard from in that many seconds), NODE_NAME (shown in
       /voice/status), NICE, PACE, KOKORO_DIR, KOKORO_MODEL, KOKORO_PROVIDER=cuda,
       TTS_ENGINE=kokoro (default) | openai (gpt-4o-mini-tts: OPENAI_API_KEY, OPENAI_BUDGET_MIN caps spend, default 300 min)
"""
import collections, gzip, hashlib, http.client, io, json, multiprocessing, os, queue, re, signal, socket, struct, sys, threading, time, urllib.parse, urllib.request
import numpy as np
import soundfile as sf

FPS = 30
EMOTIONS = ["angry", "contemplative", "excited", "joyful", "mundane", "nervous", "sad", "stern", "surprised", "tender"]
STANCES = ["agree", "disagree", "correct", "question", "joke", "inform", "expand", "praise", "retort"]
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
    """A person's voice: a fixed blend of two same-gender Kokoro voices, derived from their name. A blend is half a MB,
    so only the most recent people are kept (a table's worth and more); anyone else is blended again, the same."""

    KEEP = 64

    def __init__(self, kokoro):
        self.k, self.cache = kokoro, collections.OrderedDict()

    def of(self, user):
        if user in self.cache:
            self.cache.move_to_end(user)
        else:
            pool = FEMALE if h32(user, "g") % 2 else MALE
            a = pool[h32(user, "a") % len(pool)]
            rest = [v for v in pool if v != a]
            b = rest[h32(user, "b") % len(rest)]
            w = 0.55 + (h32(user, "w") % 1000) / 1000 * 0.35
            style = self.k.get_voice_style(a) * w + self.k.get_voice_style(b) * (1 - w)
            lang = "en-gb" if a.startswith("b") else "en-us"
            pace = (0.96 + (h32(user, "p") % 1000) / 1000 * 0.1) * SPEECH_PACE
            self.cache[user] = (style.astype(np.float32), lang, pace, f"{a}+{b}@{w:.2f}")
            while len(self.cache) > self.KEEP:
                self.cache.popitem(last=False)
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


def sentences(text):
    """A text's sentences, split exactly as towerd splits a segment's display (packages/core speakable.ts `sentences`):
    towerd sends one spoken line per sentence of it, so what is shown is what is being said."""
    t = re.sub(r"\b(e\.g|i\.e|eg|ie|vs|etc|cf|esp|incl|al|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|approx|U\.S|a\.m|p\.m)\.", lambda m: m.group(0).replace(".", "․"), text)
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


def cut_at(t, share):
    """Where to cut written text at about this share of its length: the nearest space."""
    i = round(len(t) * share)
    if i <= 0 or i >= len(t):
        return max(0, min(len(t), i))
    spaces = [x for x in (t.rfind(" ", 0, i), t.find(" ", i)) if x > 0]
    return min(spaces, key=lambda x: abs(x - i)) + 1 if spaces else i


def chunk_pairs(pairs, limit=220, first=None):
    """chunk(), for (spoken, written) sentence pairs: packed by what is said, and each clip shows the same sentences as
    written. A sentence too long for one clip is cut where chunk() cuts it, and its written form at the same share."""
    full, out, cur, shown = limit, [], "", ""
    limit = first or full
    for s, t in pairs:
        if out:
            limit = full
        while len(s) > limit:
            cut = max(s.rfind(", ", 0, limit), s.rfind(" ", 0, limit))
            cut = cut if cut > 40 else limit
            if cur:
                out.append((cur, shown))
                cur = shown = ""
            k = cut_at(t, (cut + 1) / len(s))
            out.append((s[:cut + 1].strip(), t[:k].strip() or s[:cut + 1].strip()))
            s, t = s[cut + 1:].strip(), t[k:].strip()
            limit = full
        if cur and len(cur) + 1 + len(s) > limit:
            out.append((cur, shown))
            cur, shown = s, t
            limit = full
        else:
            cur, shown = (cur + " " + s).strip(), (shown + " " + t).strip()
    if cur:
        out.append((cur, shown or cur))
    return out


def said(s, first=None):
    """A say or quote segment's clips, [(spoken, shown)]. towerd sends one spoken line per written sentence ($1.2T is
    "1.2 trillion dollars", a link is the site it goes to), so a clip shows the words it says, as they were written."""
    spoken, written = s["text"].split("\n"), sentences(s["display"])
    if len(spoken) == len(written):
        return chunk_pairs(zip(spoken, written), first=first)
    a, b = chunk(sentences(s["text"]), first=first), chunk(written, first=first)     # (from an older towerd)
    return list(zip(a, b)) if len(a) == len(b) else [(x, x) for x in a]


def plan_clips(job):
    """[(spoken text, display text, who)] in order; quotes of the parent are spoken by the parent."""
    clips = []
    for s in job["segments"]:
        k = s["kind"]
        if k == "say":
            clips += [(a, b, job["by"]) for a, b in said(s, None if clips else 110)]
        elif k == "quote":
            who = (job.get("parentBy") or job["by"]) if s.get("of") else job["by"]
            clips += [(a, "“" + b + "”", who or job["by"]) for a, b in said(s)]
        elif k == "link":
            # what towerd says for a link standing alone ("A GitHub link."), '' when it was said in its sentence or with
            # the links before it
            say = s.get("say", f"Link: {s['domain']}.")
            clips.append((say, s["url"], job["by"]))
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


class Interruptible:
    """The ONNX session, cancellable from another thread: a clip being voiced for nobody in particular gives way at
    once to someone waiting (it used to finish first, up to ~14 s on one thread). The job keeps its file and resumes
    from its last finished clip."""

    def __init__(self, sess, ort):
        self.sess, self.ort, self.opts, self.cancelled = sess, ort, None, False

    def run(self, names, feed, run_options=None):
        self.opts, self.cancelled = self.ort.RunOptions(), False
        try:
            return self.sess.run(names, feed, run_options=self.opts)
        finally:
            self.opts = None

    def cancel(self):
        o = self.opts
        if o is not None:
            self.cancelled = True
            o.terminate = True

    def __getattr__(self, k):
        return getattr(self.sess, k)


def clip_frame(meta, ogg):
    """A clip as towerd takes it, without base64 (a third smaller): a 4-byte length, the gzipped JSON (its sidecar
    snapshot carries every clip's loudness and mouth tracks so far, and squeezes well), then the Ogg bytes."""
    head = gzip.compress(json.dumps(meta, separators=(",", ":")).encode(), 1)
    return struct.pack(">I", len(head)) + head + ogg


def encode(audio, sr):
    """Ogg Opus at ~26 kbps, in memory: the same 8 kHz of speech as libsndfile's default (~36 kbps), a quarter smaller
    (measured on our own clips; at 0.94 and up the top of the voice starts to go)."""
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="OGG", subtype="OPUS", compression_level=0.92)
    return buf.getvalue()


class Towerd:
    """towerd's voice port over one kept-alive connection, used by one thread at a time (http.client isn't shared).
    A lane keeps three for its life (asking and saying done, sending clips, beating): from a worker in Paris, towerd
    is a long round trip away, and a new connection per comment paid a handshake and a cold start every time."""

    def __init__(self, url, token):
        u = urllib.parse.urlsplit(url)
        self.host, self.port, self.conn = u.hostname, u.port or 80, None
        self.auth = {"authorization": f"Bearer {token}"} if token else {}

    def post(self, path, body, timeout=30, kind="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body, separators=(",", ":")).encode()
        headers = {"content-type": kind, **self.auth}
        for attempt in (0, 1):
            try:
                if self.conn is None:
                    self.conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
                if self.conn.sock is None:       # new, or closed by the server after its last answer
                    self.conn.connect()
                    self.conn.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.conn.sock.settimeout(timeout)
                self.conn.request("POST", path, body=data, headers=headers)
                r = self.conn.getresponse()
                payload = r.read()
                return r.status, (json.loads(payload) if payload else None)
            except (OSError, http.client.HTTPException, ValueError):
                self.close()                     # a kept-alive connection the server closed: once more, fresh
                if attempt:
                    raise

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except OSError:
                pass
        self.conn = None


class Beat(threading.Thread):
    """While a comment is being voiced: renew its lease once a second, learn if more of it is wanted (an opening that
    someone sat down for), and give way mid-clip when towerd says someone more urgent is waiting. Its own connection,
    per comment. A lane that makes no clip for STUCK seconds is wedged: it stops renewing and the lane starts over
    (the lease lapses and the comment resumes elsewhere)."""

    STUCK = 150

    def __init__(self, td, lease, sess, state):
        super().__init__(daemon=True)
        self.td, self.lease, self.sess, self.state, self.halt = td, lease, sess, state, threading.Event()

    def run(self):
        while not self.halt.wait(1.0):
            if time.time() - self.state["progress"] > self.STUCK:
                print(json.dumps({"stuck": self.lease[:8], "after_s": self.STUCK}), file=sys.stderr, flush=True)
                os._exit(3)
            try:
                st, r = self.td.post("/voice/beat", {"lease": self.lease}, timeout=10)
            except Exception:  # noqa: BLE001  (a missed beat or two: the lease outlives them)
                continue
            if st == 409:
                self.state["lost"] = True
            elif st == 200 and r:
                self.state["upto"] = r.get("upto", self.state["upto"])
                self.state["yield"] = bool(r.get("yield"))
            if self.state["lost"] or self.state["yield"]:
                if self.sess is not None:
                    self.sess.cancel()
                break

    def stop(self):
        """Stop, and wait (briefly) for a beat in flight: its connection is the next comment's."""
        self.halt.set()
        self.join(3)
        return not self.is_alive()


class Uploader(threading.Thread):
    """Sends a comment's clips, in order, while the lane voices the next ones: a lane never waits on the network
    between clips (towerd is a round trip away, a fifth of a second from Paris). towerd's answers (give way? more of it
    wanted? still yours?) land in the state the lane checks between clips. At most three wait: past that the network
    sets the pace, and a stalled one trips the lane's watchdog."""

    def __init__(self, td, state):
        super().__init__(daemon=True)
        self.td, self.state, self.q = td, state, queue.Queue(maxsize=3)
        self.failed, self.last, self.total, self.sent = None, 0.0, 0.0, 0

    def run(self):
        while True:
            body = self.q.get()
            if body is None:
                break
            if self.failed or self.state["lost"]:
                continue                         # drain: nothing more of this comment is sent
            t = time.time()
            try:
                st, r = self.td.post("/voice/clip", body, kind="application/x-tohn-clip")
            except Exception as e:  # noqa: BLE001
                self.failed = f"upload: {str(e)[:100]}"
                continue
            self.last = time.time() - t
            self.total += self.last
            self.sent += 1
            if st == 409:
                self.state["lost"] = True
            elif st != 200 or not r:
                self.failed = f"clip refused: {st} {r}"
            else:
                self.state["upto"] = r.get("upto", self.state["upto"])
                if r.get("yield"):
                    self.state["yield"] = True

    def send(self, body):
        self.q.put(body)

    def finish(self):
        self.q.put(None)
        self.join()


def cpus_allowed():
    """The cores this container may use: its CPU limit if it has one, else the ones it may run on."""
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()
        if quota != "max":
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    return len(os.sched_getaffinity(0))


def config():
    cpus = cpus_allowed()
    threads = max(1, min(cpus, int(os.environ.get("THREADS", "2"))))
    lanes = int(os.environ.get("LANES", "0")) or max(1, min(int(os.environ.get("MAX_LANES", "4")), cpus // threads))
    return {"url": os.environ.get("VOICE_URL", "http://127.0.0.1:8788"), "token": os.environ.get("VOICE_TOKEN", ""),
            "cpus": cpus, "threads": threads, "lanes": lanes, "patience": float(os.environ.get("PATIENCE", "0")),
            "node": os.environ.get("NODE_NAME", "") or socket.gethostname(), "nice": int(os.environ.get("NICE", "0")),
            "engine": os.environ.get("TTS_ENGINE", "kokoro")}


def voice_job(c, kokoro, voices, oai, conns, runner):
    """One claimed comment: voice what's left of it, clip by clip, sending each as it's made."""
    lease, j = c["lease"], c["job"]
    t0 = time.time()
    plan = plan_clips(j)
    tags, prev = c.get("tags"), c.get("resume")
    if prev:
        emotion, stance, intensity, cues = prev["emotion"], prev["stance"], prev["intensity"], prev["cues"]
        clips_out, total, start = list(prev["clips"]), float(prev["dur"]), int(prev["next"])
    else:
        if tags:
            emotion, stance, intensity, cues = tags["e"], tags["s"], float(tags["i"]), list(tags["c"])
        else:
            emotion, stance, intensity, cues = heuristic_tag(" ".join(s.get("display") or s.get("text", "") for s in j["segments"]))
        clips_out, total, start = [], 0.0, 0

    def sidecar(nxt=None):
        return {"id": j["id"], "rev": j["rev"], "by": j["by"], "emotion": emotion, "stance": stance,
                "intensity": round(intensity, 2), "cues": cues, "dur": round(total, 3), "clips": clips_out,
                "links": [s for s in j["segments"] if s["kind"] == "link"],
                "code": [s["code"] for s in j["segments"] if s["kind"] == "code"],
                **({"partial": True, "of": len(plan), "next": nxt} if nxt is not None else {})}

    state = {"yield": False, "lost": False, "upto": j.get("upto", 0), "progress": time.time()}
    sess = kokoro.sess if kokoro is not None else None
    td = conns["main"]
    beat = Beat(conns["beat"], lease, sess, state)
    beat.start()
    up = Uploader(conns["up"], state)
    up.start()
    outcome = "done"
    try:
        for k, (spoken, shown, who) in enumerate(plan):
            if k < start:
                continue
            if state["lost"] or state["yield"] or up.failed:
                outcome = "lost" if state["lost"] else "yielded"
                break
            c0 = time.time()
            try:
                if oai:
                    audio, sr = oai.create(spoken, who, emotion)
                else:
                    style, lang, pace, _ = voices.of(who)
                    speed = pace * SPEED.get(emotion, 1.0) * (0.97 if who != j["by"] else 1.0)
                    audio, sr = kokoro.create(spoken, voice=style, speed=speed, lang=lang, sentence_pause=0.16, clause_pause=0.07)
            except Exception as e:  # noqa: BLE001
                if sess is not None and sess.cancelled:  # towerd said give way (or it's no longer ours)
                    outcome = "lost" if state["lost"] else "yielded"
                    break
                print("tts failed", j["id"], str(e)[:120], file=sys.stderr, flush=True)
                continue
            work = time.time() - c0
            audio = np.asarray(audio, dtype=np.float32)
            audio = audio / float(np.abs(audio).max() or 1) * 0.9
            ogg = encode(audio, sr)
            env = envelope(audio, sr)
            shp = shape_track(spoken, env)
            d = len(audio) / sr
            clips_out.append({"u": f"c/{j['id']}.{j['rev']}.{k}.ogg", "d": round(d, 3), "t": shown, "who": who,
                              "env": [int(v * 255) for v in env], "shape": [int((v + 1) * 127.5) for v in shp]})
            total += d
            part = k < len(plan) - 1
            meta = {"lease": lease, "runner": runner, "k": k, "audio_s": round(d, 3), "work_s": round(work, 3), "up_s": round(up.last, 3)}
            if part:
                meta["side"] = sidecar(k + 1)    # playable so far (serialized now: what's playable at this clip)
            up.send(clip_frame(meta, ogg))
            state["progress"] = time.time()
            if part and state["upto"] and len(clips_out) >= state["upto"]:
                outcome = "opened"               # an opening: its first words are ready; the rest is voiced on demand
                break
        up.finish()                              # every clip is at towerd (or refused) before anything is said of the whole
        if up.failed:
            raise RuntimeError(up.failed)        # the caller gives the comment back
        if state["lost"]:
            outcome = "lost"
        elif outcome == "opened":
            td.post("/voice/done", {"lease": lease, "opened": True})
        elif outcome == "done":
            st, r = td.post("/voice/done", {"lease": lease, "side": sidecar()})
            outcome = "done" if st == 200 else f"done refused {st}"
        elif outcome == "yielded":
            td.post("/voice/release", {"lease": lease})
    finally:
        if not beat.stop():                      # a beat still in flight: the next comment gets a fresh connection
            conns["beat"] = Towerd(conns["url"], conns["token"])
        if up.is_alive():
            up.finish()
    print(json.dumps({"id": j["id"], "by": j["by"], outcome: True, "emotion": emotion, "i": round(intensity, 2), "clips": len(clips_out),
                      "audio_s": round(total, 1), "wall_s": round(time.time() - t0, 1), "upload_ms": round(1000 * up.total / max(1, up.sent)),
                      "prio": j.get("prio"), "lane": runner}), flush=True)


def lane(n, cfg):
    """One lane: its own Kokoro session (and its own espeak: processes, not threads), claiming and voicing forever."""
    if cfg["nice"]:
        os.nice(cfg["nice"])
    current = {"lease": None}
    conns = {"main": Towerd(cfg["url"], cfg["token"]), "up": Towerd(cfg["url"], cfg["token"]), "beat": Towerd(cfg["url"], cfg["token"]),
             "url": cfg["url"], "token": cfg["token"]}

    def bye(*_):
        # a rollout: give the comment back at once, so nobody waits for its lease to lapse
        if current["lease"]:
            try:
                Towerd(cfg["url"], cfg["token"]).post("/voice/release", {"lease": current["lease"]}, timeout=2)
            except Exception:  # noqa: BLE001
                pass
        os._exit(0)
    signal.signal(signal.SIGTERM, bye)
    kokoro = voices = oai = None
    if cfg["engine"] == "openai":
        oai = OpenAITTS(os.environ["OPENAI_API_KEY"], float(os.environ.get("OPENAI_BUDGET_MIN", "300")) / cfg["lanes"])   # the cap is the runner's
    else:
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
        models = os.path.expanduser(os.environ.get("KOKORO_DIR", "~/.cache/tohn-models"))
        # kokoro-v1.0.fp16.onnx: the original's weights rounded to half precision (as Kokoro runs on GPUs). On a CPU
        # core it measured 0.94x real time vs 0.77x for fp32, and every runner uses the same model, so a comment
        # resumed on another node sounds the same. KOKORO_PROVIDER=cuda runs it on a GPU (onnxruntime-gpu).
        model = os.environ.get("KOKORO_MODEL", "kokoro-v1.0.fp16.onnx")
        providers = (["CUDAExecutionProvider"] if os.environ.get("KOKORO_PROVIDER") == "cuda" else []) + ["CPUExecutionProvider"]
        so = ort.SessionOptions()
        so.intra_op_num_threads = cfg["threads"]
        so.inter_op_num_threads = 1
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")   # idle threads sleep, not spin
        kokoro = Kokoro.from_session(ort.InferenceSession(f"{models}/{model}", so, providers=providers), f"{models}/voices-v1.0.bin")
        kokoro.sess = Interruptible(kokoro.sess, ort)
        voices = Voices(kokoro)
    runner = f"{cfg['node']}/{socket.gethostname()}/{n}"
    print(json.dumps({"lane": runner, "ready": True, "threads": cfg["threads"], "engine": cfg["engine"]}), flush=True)

    def work():
        try:
            claim_and_voice(cfg, runner, current, kokoro, voices, oai, conns)
        except BaseException as e:  # noqa: BLE001  (the lane dies whole, and the runner starts it again)
            print("lane", runner, repr(e)[:160], file=sys.stderr, flush=True)
            os._exit(1)
    # the voicing runs in a thread: this one stays free for signals (a handler can't run while the main thread is
    # inside ONNX), so a rollout gives the comment back at once
    threading.Thread(target=work, daemon=True).start()
    while True:
        signal.pause()


def claim_and_voice(cfg, runner, current, kokoro, voices, oai, conns):
    td = conns["main"]
    quiet = 0
    while True:
        try:
            st, c = td.post("/voice/claim", {"runner": runner, "node": cfg["node"], "cpus": cfg["cpus"], "threads": cfg["threads"],
                                             "patience": cfg["patience"]}, timeout=45)
        except Exception as e:  # noqa: BLE001  (towerd restarting, or the node's network blinking)
            quiet = min(quiet + 1, 6)
            print("claim", str(e)[:120], file=sys.stderr, flush=True)
            time.sleep(2 ** quiet / 2)
            continue
        quiet = 0
        if st != 200 or not c or c.get("again"):
            if st not in (200, 204):
                time.sleep(2)
            continue
        current["lease"] = c["lease"]
        try:
            voice_job(c, kokoro, voices, oai, conns, runner)
        except Exception as e:  # noqa: BLE001  (give it back: someone else, or this lane later, resumes it)
            print("job", c["job"]["id"], str(e)[:160], file=sys.stderr, flush=True)
            try:
                td.post("/voice/release", {"lease": c["lease"]}, timeout=5)
            except Exception:  # noqa: BLE001
                pass
            time.sleep(1)
        finally:
            current["lease"] = None


def main():
    cfg = config()
    print(json.dumps({"runner": cfg["node"], "lanes": cfg["lanes"], "threads": cfg["threads"], "cpus": cfg["cpus"],
                      "patience": cfg["patience"], "towerd": cfg["url"]}), flush=True)
    ctx = multiprocessing.get_context("spawn")
    procs = {}

    def start(n):
        p = ctx.Process(target=lane, args=(n, cfg), daemon=True)
        p.start()
        procs[n] = (p, time.time())

    def bye(*_):
        for p, _ in procs.values():
            p.terminate()
        for p, _ in procs.values():
            p.join(5)
        sys.exit(0)
    signal.signal(signal.SIGTERM, bye)
    for n in range(cfg["lanes"]):
        start(n)
    while True:
        time.sleep(5)
        for n, (p, since) in list(procs.items()):
            if not p.is_alive():
                print(json.dumps({"lane": n, "exited": p.exitcode, "after_s": round(time.time() - since)}), file=sys.stderr, flush=True)
                time.sleep(2)
                start(n)


if __name__ == "__main__":
    main()
