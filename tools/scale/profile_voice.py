#!/usr/bin/env python3
"""Where a clip's time goes, end to end, exactly as a runner lane makes it (apps/voice-worker/worker.py): the
phonemes (espeak), the model (ONNX Runtime, with its own per-operator profile), trimming, normalising, the Opus
encode and the mouth/loudness tracks. One process, the same model file and session options as the runner.

usage: profile_voice.py MODELS_DIR [THREADS=1] [REPS=3] [--ort-profile]
prints JSON: per stage ms (median of REPS) for a first clip (~110 chars) and a full clip (~220 chars), the real-time
factor, and (--ort-profile) the operators that take the most time."""
import json, os, sys, time, statistics as st, importlib.util, pathlib

models = sys.argv[1]
threads = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 1
reps = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 3
ort_profile = '--ort-profile' in sys.argv
here = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('worker', here.parent.parent / 'apps/voice-worker/worker.py')
W = importlib.util.module_from_spec(spec); spec.loader.exec_module(W)

import numpy as np, onnxruntime as ort
from kokoro_onnx import Kokoro

so = ort.SessionOptions()
so.intra_op_num_threads = threads
so.inter_op_num_threads = 1
so.add_session_config_entry('session.intra_op.allow_spinning', '0')
if ort_profile:
    so.enable_profiling = True
    so.profile_file_prefix = '/tmp/tohn-ort-profile'
t = time.perf_counter()
sess = ort.InferenceSession(f'{models}/kokoro-v1.0.fp16.onnx', so, providers=['CPUExecutionProvider'])
k = Kokoro.from_session(sess, f'{models}/voices-v1.0.bin')
load_ms = (time.perf_counter() - t) * 1000
voices = W.Voices(k)

FIRST = "I have no real confidence in this take, but I'll go against the grain and argue that the labs do not."
FULL = ("The thing people miss about this is that the cost isn't in the hardware at all, it's in the people who keep it "
        "running. Every time we tried to cut that, the outages came back within a month, and we paid for it twice.")

tok = k.tokenizer

def stage_times(text, who='pg'):
    out = {}
    style, lang, pace, _ = voices.of(who)
    t0 = time.perf_counter(); ph = tok.phonemize(text, lang); out['phonemize_ms'] = (time.perf_counter() - t0) * 1000
    # the model, alone, on that one batch (kokoro_onnx's own _infer: tokens + the style row for its length)
    toks = k.tokenizer.tokenize(ph)
    t0 = time.perf_counter(); k._infer(toks, k._style_for(style, len(toks)), pace); out['model_ms'] = (time.perf_counter() - t0) * 1000
    # the whole of kokoro.create, as the worker calls it
    t0 = time.perf_counter()
    audio, sr = k.create(text, voice=style, speed=pace, lang=lang, sentence_pause=0.16, clause_pause=0.07)
    out['create_ms'] = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter(); audio = np.asarray(audio, dtype=np.float32); audio = audio / float(np.abs(audio).max() or 1) * 0.9; out['normalise_ms'] = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter(); ogg = W.encode(audio, sr); out['opus_ms'] = (time.perf_counter() - t0) * 1000
    t0 = time.perf_counter(); env = W.envelope(audio, sr); W.shape_track(text, env); out['tracks_ms'] = (time.perf_counter() - t0) * 1000
    out['audio_s'] = len(audio) / sr
    out['ogg_bytes'] = len(ogg)
    out['phonemes'] = len(ph)
    return out

res = {'threads': threads, 'load_ms': round(load_ms), 'ort': ort.__version__}
stage_times('Warm up.')
for name, text in (('first_clip', FIRST), ('full_clip', FULL)):
    runs = [stage_times(text) for _ in range(reps)]
    agg = {key: round(st.median(r[key] for r in runs), 1) for key in runs[0] if isinstance(runs[0][key], (int, float))}
    agg['rtf'] = round(agg['audio_s'] / (agg['create_ms'] / 1000), 2)
    agg['chars'] = len(text)
    res[name] = agg
if ort_profile:
    prof = sess.end_profiling()
    ops = {}
    for ev in json.load(open(prof)):
        if ev.get('cat') == 'Node' and ev.get('name', '').endswith('_kernel_time'):
            op = ev.get('args', {}).get('op_name', '?')
            ops[op] = ops.get(op, 0) + ev.get('dur', 0)
    total = sum(ops.values()) or 1
    res['ops_top'] = [[op, round(100 * us / total, 1)] for op, us in sorted(ops.items(), key=lambda x: -x[1])[:14]]
    os.unlink(prof)
print(json.dumps(res))
