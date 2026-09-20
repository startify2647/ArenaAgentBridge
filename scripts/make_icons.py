#!/usr/bin/env python3
"""Generate the extension icons (pure stdlib - no Pillow needed).

    python scripts/make_icons.py

Draws a rounded-square badge with a cyan "A" over a small bridge deck and writes
extension/icons/icon{16,32,48,128}.png.  Anti-aliasing is done by rendering at
4x and box-downsampling.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"
SCALE = 4

BG_TOP = (13, 17, 23)
BG_BOTTOM = (22, 27, 34)
FG = (88, 166, 255)      # #58a6ff
FG_DARK = (57, 208, 83)  # #39d353


def sd_round_rect(px: float, py: float, cx: float, cy: float, hw: float, hh: float, r: float) -> float:
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def sd_capsule(px: float, py: float, ax: float, ay: float, bx: float, by: float, r: float) -> float:
    pax, pay = px - ax, py - ay
    bax, bay = bx - ax, by - ay
    denom = bax * bax + bay * bay
    h = 0.0 if denom == 0 else max(0.0, min(1.0, (pax * bax + pay * bay) / denom))
    return math.hypot(pax - bax * h, pay - bay * h) - r


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size: int) -> bytes:
    n = size * SCALE
    px = bytearray(n * n * 4)

    # geometry in 0..1 space, scaled to n
    def s(v: float) -> float:
        return v * n

    cx = cy = n / 2.0
    radius = s(0.22)
    stem_w = s(0.085)
    apex_y = s(0.24)
    foot_y = s(0.70)
    deck_y = s(0.80)
    post_w = s(0.035)

    for y in range(n):
        for x in range(n):
            pxc, pyc = x + 0.5, y + 0.5
            # background
            d_bg = sd_round_rect(pxc, pyc, cx, cy, n / 2 - 0.5, n / 2 - 0.5, radius)
            if d_bg > 0:
                continue
            bg = mix(BG_TOP, BG_BOTTOM, y / n)

            # glyph: "A" as two capsules + crossbar, over a bridge deck
            d_left = sd_capsule(pxc, pyc, s(0.30), foot_y, s(0.50), apex_y, stem_w / 2)
            d_right = sd_capsule(pxc, pyc, s(0.50), apex_y, s(0.70), foot_y, stem_w / 2)
            d_bar = sd_capsule(pxc, pyc, s(0.365), s(0.555), s(0.635), s(0.555), stem_w * 0.42)
            d_deck = sd_capsule(pxc, pyc, s(0.20), deck_y, s(0.80), deck_y, post_w)
            d_post1 = sd_capsule(pxc, pyc, s(0.32), s(0.70), s(0.32), deck_y, post_w * 0.8)
            d_post2 = sd_capsule(pxc, pyc, s(0.68), s(0.70), s(0.68), deck_y, post_w * 0.8)
            d_arc = sd_capsule(pxc, pyc, s(0.20), deck_y, s(0.20), s(0.70), post_w * 0.5)

            glyph = min(d_left, d_right, d_bar)
            deck = min(d_deck, d_post1, d_post2, d_arc)
            edge = min(glyph, deck)

            if edge <= 0:
                depth = min(1.0, -edge / s(0.05))
                color = mix(FG, FG_DARK, depth * 0.35) if glyph <= deck else mix(FG_DARK, FG, 0.35)
                rgba = (*color, 255)
            else:
                rgba = (*bg, 255)
            offset = (y * n + x) * 4
            px[offset : offset + 4] = bytes(rgba)

    # downsample (box filter) to the target size
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SCALE):
                for dx in range(SCALE):
                    offset = ((y * SCALE + dy) * n + (x * SCALE + dx)) * 4
                    r += px[offset]
                    g += px[offset + 1]
                    b += px[offset + 2]
                    a += px[offset + 3]
            count = SCALE * SCALE
            offset = (y * size + x) * 4
            out[offset : offset + 4] = bytes((r // count, g // count, b // count, a // count))
    return bytes(out)


def write_png(path: Path, size: int, rgba: bytes) -> None:
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter: none
        raw.extend(rgba[y * stride : (y + 1) * stride])

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    print(f"wrote {path} ({len(png)} bytes)")


def main() -> None:
    for size in (16, 32, 48, 128):
        write_png(OUT_DIR / f"icon{size}.png", size, render(size))


if __name__ == "__main__":
    main()
