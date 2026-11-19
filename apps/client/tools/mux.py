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
def chair():
    """The client's chair scrape (audio.ts sfxAt), rebuilt offline: a slowing saw through two wooden resonances."""
    d = 0.44
    t = np.arange(int(d * sr)) / sr
    phase = np.cumsum(58 + (34 - 58) * np.minimum(t / 0.4, 1)) / sr
    x = 2 * (phase % 1) - 1 + rng.standard_normal(len(t)) * 0.35
    X, fr = np.fft.rfft(x), np.fft.rfftfreq(len(x), 1 / sr)
    y = np.fft.irfft(X * (np.exp(-((fr - 620) / 110) ** 2) + 0.6 * np.exp(-((fr - 1450) / 150) ** 2)), len(x))
    y *= np.interp(t, [0, 0.04, 0.26, d], [0, 1, 0.7, 0])
    return (y / (np.abs(y).max() + 1e-9) * 0.16).astype(np.float32)

def thump():
    """audio.ts sfxAt('thump'): palms on a tabletop, a falling low sine and a short knock."""
    d = 0.3
    t = np.arange(int(d * sr)) / sr
    f = 92 * (58 / 92) ** np.minimum(t / 0.2, 1)
    body = np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t / 0.06) * 0.5
    knock = rng.standard_normal(len(t)) * np.exp(-t / 0.012) * 0.25
    X, fr = np.fft.rfft(knock), np.fft.rfftfreq(len(t), 1 / sr)
    knock = np.fft.irfft(X * (fr < 900), len(t))
    return ((body + knock) * 0.6).astype(np.float32)

SFX = {"sfx:chair": chair(), "sfx:thump": thump()}
for c in meta["timeline"]:
    if c["url"] in SFX:
        at = int((c["when"] - clock0) * sr)
        if 0 <= at < len(track):
            seg = SFX[c["url"]][: len(track) - at]
            track[at: at + len(seg)] += seg
        continue
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
