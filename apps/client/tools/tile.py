#!/usr/bin/env python3
"""Tile a contact sheet made by sheet.cjs into one image, captioned with time, shot and subtitle.
usage: tile.py <sheet dir> [columns] [scale]"""
import json, sys
from PIL import Image, ImageDraw

d = sys.argv[1]
cols = int(sys.argv[2]) if len(sys.argv) > 2 else 4
scale = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
meta = json.load(open(f"{d}/sheet.json"))["meta"]
ims = [Image.open(m["file"]) for m in meta]
w, h = int(ims[0].width * scale), int(ims[0].height * scale)
cap = 26
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * (h + cap)), (12, 12, 14))
dr = ImageDraw.Draw(sheet)
for k, (im, m) in enumerate(zip(ims, meta)):
    x, y = (k % cols) * w, (k // cols) * (h + cap)
    sheet.paste(im.resize((w, h)), (x, y))
    dr.text((x + 4, y + h + 2), f"{m['clock']:.1f}s {m['shot']}", fill=(255, 210, 120))
    dr.text((x + 4, y + h + 13), m["sub"][:52], fill=(200, 200, 200))
sheet.save(f"{d}/sheet.jpg", quality=88)
print(f"{d}/sheet.jpg", sheet.size)
