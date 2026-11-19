#!/usr/bin/env python3
"""Lay the real voice clips under recorded frames, exactly when the director played them.

usage: mux.py <frames dir> <var dir> <out.mp4>
Adds a quiet room tone so silences between turns don't sound dead.
"""
import json, os, subprocess, sys
import numpy as np
import soundfile as sf

frames, var, out = sys.argv[1:4]
meta = json.load(open(os.path.join(frames, "timeline.json")))
fps, clock0 = meta["fps"], meta["clock0"]
n = len([f for f in os.listdir(frames) if f.endswith(".jpg")])
sr = 24000
track = np.zeros(int(n / fps * sr) + sr, dtype=np.float32)
rng = np.random.default_rng(7)
room = np.convolve(rng.standard_normal(len(track)), np.ones(400) / 400, mode="same").astype(np.float32)
track += room / (np.abs(room).max() + 1e-9) * 0.012
for c in meta["timeline"]:
    rel = c["url"].split("/live/", 1)[-1]
    path = os.path.join(var, "live", rel)
    if not os.path.exists(path):
        continue
    a, r = sf.read(path, dtype="float32", always_2d=True)
    a = a.mean(axis=1)
    if r != sr:
        a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * sr / r)), np.arange(len(a)), a).astype(np.float32)
    at = int((c["when"] - clock0) * sr)
    if at < 0 or at >= len(track):
        continue
    seg = a[: len(track) - at]
    track[at: at + len(seg)] += seg * 0.85
track = track[: int(n / fps * sr)]
wav = os.path.join(frames, "track.wav")
sf.write(wav, np.clip(track, -1, 1), sr)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", os.path.join(frames, "f%05d.jpg"), "-i", wav,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "21", "-preset", "medium", "-c:a", "aac", "-b:a", "128k",
                "-shortest", "-movflags", "+faststart", out], check=True)
print("wrote", out, f"{n / fps:.1f}s", len(meta["timeline"]), "clips")
