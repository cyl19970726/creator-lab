#!/usr/bin/env python3
"""Render a small, explicitly labeled contact page from extracted cut frames."""
import json
import sys
from PIL import Image, ImageDraw


rows = json.loads(sys.argv[1])
output = sys.argv[2]
cell_width, image_height, header_height = 368, 640, 42
row_height = image_height + header_height + 30
canvas = Image.new("RGB", (cell_width * 2, row_height * len(rows)), "#151515")
draw = ImageDraw.Draw(canvas)
for index, row in enumerate(rows):
    top = index * row_height
    draw.text((8, top + 6), f"{row['id']}  cut {row['boundary']:.3f}s  {row['fromShot']} > {row['toShot']}", fill="white")
    for column, side in enumerate(("before", "after")):
        frame = row[side]
        with Image.open(frame["path"]) as source:
            image = source.convert("RGB")
            image.thumbnail((360, image_height))
        x = column * cell_width + (cell_width - image.width) // 2
        canvas.paste(image, (x, top + header_height))
        draw.text((column * cell_width + 8, top + header_height + image_height + 5),
                  f"{frame['id']}  {frame['time']:.3f}s", fill="white")
canvas.save(output, quality=88)
