"""Generate the toolbar icons for the Firefox Volume Mixer extension.

Run with:  python tools/make_icons.py
Writes icons/icon-48.png, icons/icon-96.png and icons/icon-128.png.
Requires Pillow (pip install pillow).
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "icons")

BACKGROUND = (143, 107, 255, 255)   # #8f6bff
SPEAKER = (255, 255, 255, 255)
WAVE = (255, 255, 255, 235)
BAR = (255, 255, 255, 255)
BAR_OFF = (255, 255, 255, 90)


def draw_icon(size: int) -> Image.Image:
    # Work at 4x and downsample for smooth edges.
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=BACKGROUND)

    def px(v: float) -> float:
        return v * s

    # Speaker body + cone.
    d.polygon(
        [
            (px(0.20), px(0.40)),
            (px(0.31), px(0.40)),
            (px(0.44), px(0.27)),
            (px(0.44), px(0.73)),
            (px(0.31), px(0.60)),
            (px(0.20), px(0.60)),
        ],
        fill=SPEAKER,
    )

    # Two sound waves.
    for index, radius_fraction in enumerate((0.13, 0.21)):
        box = [
            px(0.44 - radius_fraction),
            px(0.50 - radius_fraction),
            px(0.44 + radius_fraction),
            px(0.50 + radius_fraction),
        ]
        d.arc(box, start=-58, end=58, fill=WAVE, width=max(scale, int(s * 0.045)))

    # Three level bars on the right.
    bar_w = s * 0.075
    gap = s * 0.055
    x = s * 0.68
    heights = (0.26, 0.38, 0.50)
    for index, h in enumerate(heights):
        top = s * 0.50 - s * h / 2
        bottom = s * 0.50 + s * h / 2
        colour = BAR if index < 2 else BAR_OFF
        d.rounded_rectangle(
            [x, top, x + bar_w, bottom],
            radius=bar_w / 2,
            fill=colour,
        )
        x += bar_w + gap

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (48, 96, 128):
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        draw_icon(size).save(path, "PNG")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
