#!/usr/bin/env python3
"""Lay the real comment clips under the recorded frames, exactly where the page played them.

usage: mux.py <frames dir> <data dir> <out.mp4>
Video time 0 = the first captured frame = page clock `clock0`.
"""
import json, os, subprocess, sys
import numpy as np
import soundfile as sf

frames, data, out = sys.argv[1:4]
meta = json.load(open(os.path.join(frames, "timeline.json")))
fps, clock0 = meta["fps"], meta["clock0"]
n_frames = len([f for f in os.listdir(frames) if f.endswith(".jpg")])
sr = 24000
track = np.zeros(int(n_frames / fps * sr) + sr, dtype=np.float32)
for cue in meta["timeline"]:
    a, r = sf.read(os.path.join(data, "c", f'{cue["id"]}.ogg'), dtype="float32", always_2d=True)
    a = a.mean(axis=1)
    if r != sr:
        a = np.interp(np.linspace(0, len(a) - 1, int(len(a) * sr / r)), np.arange(len(a)), a).astype(np.float32)
    at = int((cue["start"] - clock0) * sr)
    if at >= len(track):
        break
    seg = a[: len(track) - at]
    track[at: at + len(seg)] += seg * 0.9
track = track[: int(n_frames / fps * sr)]
wav = os.path.join(frames, "track.wav")
sf.write(wav, track, sr)
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", os.path.join(frames, "f%05d.jpg"), "-i", wav,
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-c:a", "aac", "-b:a", "96k", "-shortest", "-movflags", "+faststart", out], check=True)
print("wrote", out, f"{n_frames / fps:.1f}s")
