#!/usr/bin/env python3
"""Top-down plans of the table for chosen contact-sheet frames: who sits where, who stands, where the lens is.
usage: plan.py <sheet dir> <frame index>..."""
import json, math, sys
from PIL import Image, ImageDraw

d = sys.argv[1]
meta = json.load(open(f"{d}/sheet.json"))["meta"]
S = 120  # px per metre
for k in map(int, sys.argv[2:]):
    m = meta[k]; sc = m["scene"]
    if not sc["table"]:
        continue
    cx, _, cz = sc["table"]["pos"]
    im = Image.new("RGB", (720, 720), (20, 20, 24)); dr = ImageDraw.Draw(im)
    P = lambda x, z: (360 + (x - cx) * S, 360 + (z - cz) * S)
    r = sc["table"]["r"] * S
    dr.ellipse([360 - r, 360 - r, 360 + r, 360 + r], outline=(140, 90, 50), width=2)
    for p in sc["people"]:
        x, y, z = p["head"]
        if math.hypot(x - cx, z - cz) > 2.9:
            continue
        u, v = P(x, z)
        col = (255, 120, 80) if p["stand"] > 0.5 and p["seated"] else (120, 200, 255) if p["at"] else (90, 90, 90)
        dr.ellipse([u - 22, v - 22, u + 22, v + 22], outline=col, width=2)
        a = p["facing"] + p["turn"] + max(-1.1, min(1.1, p["yaw"]))
        dr.line([u, v, u + math.sin(a) * 34, v + math.cos(a) * 34], fill=col, width=2)
        dr.text((u - 20, v + 24), f'{p["name"][:10]} {y:.2f}', fill=col)
    x, y, z = sc["cam"]; tx, ty, tz = sc["target"]
    u, v = P(x, z); tu, tv = P(tx, tz)
    dr.rectangle([u - 6, v - 6, u + 6, v + 6], fill=(255, 230, 90))
    dr.line([u, v, tu, tv], fill=(255, 230, 90), width=1)
    dr.text((8, 8), f'{m["clock"]:.1f}s {m["shot"]}  cam y={y:.2f} target y={ty:.2f}', fill=(255, 230, 90))
    im.save(f"{d}/plan{k:03d}.png")
    print(f"{d}/plan{k:03d}.png")
