"""Test pages for scripts/ocr-check/compare.mjs: lines of known text in a few fonts and sizes, some pages
slightly rotated or blurred, written as raw RGBA next to meta.json (the truth). pip install pillow."""
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ocr-check'
os.makedirs(out, exist_ok=True)
random.seed(3)
LINES = [
    'The quick brown fox jumps over the lazy dog near the river bank.',
    'Invoice 2024-0193: total due 1,284.50 EUR by 15 March 2025.',
    'Section 4.2 describes the experimental setup and results.',
    'Contact: support@example.com or call +1 (555) 013-2468.',
    'Temperature rose from 12.5 C to 31.8 C over six hours.',
    'Chapter Seven: A Journey Through the Northern Mountains',
]
FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
         '/usr/share/fonts/truetype/freefont/FreeSans.ttf']
W, H = 1700, 2200   # a Letter page at 200 dpi, as the viewer sends them
truth = []
for k in range(6):
    im = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(im)
    y, lines = 150, []
    for j in range(14):
        size = [30, 36, 42, 28][j % 4]
        text = LINES[(j + k) % len(LINES)]
        d.text((140, y), text, font=ImageFont.truetype(FONTS[(j + k) % 3], size), fill=random.randint(0, 60))
        lines.append(text)
        y += size * 2 + 10
    if k % 3 == 1:
        im = im.rotate(1.5, fillcolor=255)
    if k % 3 == 2:
        im = im.filter(ImageFilter.GaussianBlur(1.1))
    open(os.path.join(out, f'{k}.rgba'), 'wb').write(im.convert('RGBA').tobytes())
    truth.append(lines)
json.dump({'w': W, 'h': H, 'truth': truth}, open(os.path.join(out, 'meta.json'), 'w'))
print('wrote', len(truth), 'pages to', out)
