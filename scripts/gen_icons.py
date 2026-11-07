# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate icons/icon{16,48,128}.png: a white ">>>" on a WebAssembly-style tile.

The tile echoes the WebAssembly logo: a purple square with a semicircular
notch cut out of the top edge.

Usage:
    uv run scripts/gen_icons.py

Pure standard library (zlib + struct PNG writer), so there are no packages to
install. Each chevron is drawn as a thick polyline with signed-distance
anti-aliasing via 4x4 supersampling.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ICON_SIZES = (16, 48, 128)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = PROJECT_ROOT / "icons"

SUPERSAMPLE = 4  # samples per axis per pixel
BACKGROUND_RGB = (0x65, 0x4F, 0xF0)  # WebAssembly purple (#654FF0)
GLYPH_RGB = (0xFF, 0xFF, 0xFF)  # white
CORNER_RADIUS_FRAC = 0.10  # of the icon size
# Semicircular notch centred on the top edge, as in the WebAssembly logo.
NOTCH_CENTER = (0.5, 0.0)
NOTCH_RADIUS = 0.17
CHEVRON_COUNT = 3
# Glyph geometry in unit coordinates (0..1 of the icon size).
GLYPH_LEFT = 0.14
GLYPH_RIGHT = 0.86
GLYPH_CENTER_Y = 0.58  # below centre, to clear the notch
CHEVRON_HALF_HEIGHT = 0.20
CHEVRON_WIDTH_FRAC = 0.62  # chevron width as a fraction of the per-chevron pitch
STROKE_WIDTH = 0.085
# Small sizes need a relatively thicker stroke to stay legible.
MIN_STROKE_PX = 1.6

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_COLOR_TYPE_RGBA = 6
PNG_BIT_DEPTH = 8
PNG_FILTER_NONE = 0
ZLIB_LEVEL = 9

Point = tuple[float, float]


def segment_distance(p: Point, a: Point, b: Point) -> float:
    """Euclidean distance from p to segment ab."""
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    t = 0.0 if length_sq == 0.0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def chevron_segments() -> list[tuple[Point, Point]]:
    """Segments (unit coordinates) of CHEVRON_COUNT '>' shapes side by side."""
    pitch = (GLYPH_RIGHT - GLYPH_LEFT) / CHEVRON_COUNT
    width = pitch * CHEVRON_WIDTH_FRAC
    mid_y = GLYPH_CENTER_Y
    segments: list[tuple[Point, Point]] = []
    for i in range(CHEVRON_COUNT):
        x0 = GLYPH_LEFT + i * pitch + (pitch - width) / 2
        tip = (x0 + width, mid_y)
        segments.append(((x0, mid_y - CHEVRON_HALF_HEIGHT), tip))
        segments.append(((x0, mid_y + CHEVRON_HALF_HEIGHT), tip))
    return segments


def inside_tile(x: float, y: float, radius: float) -> bool:
    """(x, y) in unit coordinates; true inside the rounded tile minus the notch."""
    nx, ny = NOTCH_CENTER
    if (x - nx) ** 2 + (y - ny) ** 2 <= NOTCH_RADIUS * NOTCH_RADIUS:
        return False
    cx = min(max(x, radius), 1.0 - radius)
    cy = min(max(y, radius), 1.0 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def render(size: int) -> bytes:
    """Return raw RGBA rows (with PNG filter bytes) for one icon size."""
    segments = chevron_segments()
    half_stroke = max(STROKE_WIDTH, MIN_STROKE_PX / size) / 2
    rows = bytearray()
    samples_total = SUPERSAMPLE * SUPERSAMPLE
    for py in range(size):
        rows.append(PNG_FILTER_NONE)
        for px in range(size):
            tile_hits = 0
            glyph_hits = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px + (sx + 0.5) / SUPERSAMPLE) / size
                    y = (py + (sy + 0.5) / SUPERSAMPLE) / size
                    if not inside_tile(x, y, CORNER_RADIUS_FRAC):
                        continue
                    tile_hits += 1
                    if min(segment_distance((x, y), a, b) for a, b in segments) <= half_stroke:
                        glyph_hits += 1
            alpha = tile_hits / samples_total
            if tile_hits == 0:
                rows += bytes((0, 0, 0, 0))
                continue
            mix = glyph_hits / tile_hits
            rgb = [round(bg + (fg - bg) * mix) for bg, fg in zip(BACKGROUND_RGB, GLYPH_RGB, strict=True)]
            rows += bytes((*rgb, round(alpha * 255)))
    return bytes(rows)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def encode_png(size: int, raw_rows: bytes) -> bytes:
    header = struct.pack(">IIBBBBB", size, size, PNG_BIT_DEPTH, PNG_COLOR_TYPE_RGBA, 0, 0, 0)
    return (
        PNG_SIGNATURE
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(raw_rows, ZLIB_LEVEL))
        + png_chunk(b"IEND", b"")
    )


def main() -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for size in ICON_SIZES:
        out = ICONS_DIR / f"icon{size}.png"
        out.write_bytes(encode_png(size, render(size)))
        print(f"wrote {out.relative_to(PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
