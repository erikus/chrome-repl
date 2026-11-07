# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==12.0.0"]
# ///
"""Turn the window captures from scripts/demo.mjs into committed images.

Usage:
    uv run scripts/demo_assemble.py gif    # .cache/demo/gif/   -> docs/demo.gif
    uv run scripts/demo_assemble.py store  # .cache/demo/store/ -> docs/store/screenshot-*.png

Every capture is the browser window's screen region, so it carries the
window's rounded corners (with a sliver of whatever is behind them) and its
1 px outline. Both are trimmed: the outline is cropped off and the corners are
squared off with the colour just inside them. The GIF gets a key caption
(the shortcut each step stands for) drawn bottom-centre.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CAPTURE_ROOT = PROJECT_ROOT / ".cache" / "demo"
GIF_OUT = PROJECT_ROOT / "docs" / "demo.gif"
STORE_OUT_DIR = PROJECT_ROOT / "docs" / "store"

# In capture pixels (2x points on Retina).
EDGE_INSET_PX = 2  # window outline
CORNER_RADIUS_PX = 30  # macOS window corner, a little generous
# Where the corner fill colour is sampled, measured from each corner (x, y).
TOP_CORNER_SAMPLE = (CORNER_RADIUS_PX, CORNER_RADIUS_PX // 2)
BOTTOM_CORNER_SAMPLE = (CORNER_RADIUS_PX, CORNER_RADIUS_PX // 2)

STORE_SIZE = (1280, 800)  # Chrome Web Store screenshot size
GIF_WIDTH = 960
GIF_COLORS = 256
GIF_DURATION_UNIT_MS = 10  # GIF delays are stored in centiseconds
GIF_LOOP_FOREVER = 0

# Key caption, in GIF pixels.
CAPTION_FONT_SIZE = 26
CAPTION_PAD = (18, 8)  # horizontal, vertical
CAPTION_RADIUS = 10
CAPTION_MARGIN_BOTTOM = 22
CAPTION_FILL = (32, 33, 36, 225)
CAPTION_TEXT = (255, 255, 255, 255)
# First font that has a glyph wins, per character: SF for letters, then fonts
# with the modifier-key symbols (⌥ ⇧ ⌘ ⏎).
CAPTION_FONTS = (
    Path("/System/Library/Fonts/SFNS.ttf"),
    Path("/System/Library/Fonts/Apple Symbols.ttf"),
    Path("/System/Library/Fonts/Menlo.ttc"),
)
# A private-use code point no font maps; its mask is the .notdef box.
MISSING_PROBE_CHAR = "\U0010fffd"
CAPTION_LETTER_SPACING = 2


@dataclass(frozen=True)
class Frame:
    image: Image.Image
    hold_ms: int
    caption: str | None


def square_corners(image: Image.Image) -> Image.Image:
    """Crop the window outline and fill the rounded corners with nearby colour."""
    w, h = image.size
    img = image.convert("RGB").crop((EDGE_INSET_PX, EDGE_INSET_PX, w - EDGE_INSET_PX, h - EDGE_INSET_PX))
    w, h = img.size
    r = CORNER_RADIUS_PX
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
    fill = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(fill)
    tx, ty = TOP_CORNER_SAMPLE
    bx, by = BOTTOM_CORNER_SAMPLE
    draw.rectangle((0, 0, r, r), fill=img.getpixel((tx, ty)))
    draw.rectangle((w - 1 - r, 0, w - 1, r), fill=img.getpixel((w - 1 - tx, ty)))
    draw.rectangle((0, h - 1 - r, r, h - 1), fill=img.getpixel((bx, h - 1 - by)))
    draw.rectangle((w - 1 - r, h - 1 - r, w - 1, h - 1), fill=img.getpixel((w - 1 - bx, h - 1 - by)))
    return Image.composite(img, fill, mask)


def load_manifest(mode: str) -> dict:
    path = CAPTURE_ROOT / mode / {"gif": "frames.json", "store": "shots.json"}[mode]
    if not path.exists():
        raise SystemExit(f"{path} missing; run `node scripts/demo.mjs {mode}` first")
    return json.loads(path.read_text())


class CaptionFont:
    """Per-character font fallback across CAPTION_FONTS."""

    def __init__(self, size: int) -> None:
        self.fonts = []
        for path in CAPTION_FONTS:
            if not path.exists():
                raise SystemExit(f"caption font missing: {path}")
            self.fonts.append(ImageFont.truetype(str(path), size))

    def font_for(self, ch: str) -> ImageFont.FreeTypeFont:
        for font in self.fonts:
            if ch == " " or bytes(font.getmask(ch)) != bytes(font.getmask(MISSING_PROBE_CHAR)):
                return font
        raise SystemExit(f"no caption font has a glyph for {ch!r}")

    def layout(self, text: str) -> list[tuple[str, ImageFont.FreeTypeFont, float]]:
        """(char, font, advance) per character."""
        return [(ch, f := self.font_for(ch), f.getlength(ch) + CAPTION_LETTER_SPACING) for ch in text]


def draw_caption(image: Image.Image, text: str, font: CaptionFont) -> Image.Image:
    glyphs = font.layout(text)
    text_w = sum(adv for _, _, adv in glyphs) - CAPTION_LETTER_SPACING
    ascent, descent = font.fonts[0].getmetrics()
    text_h = ascent + descent
    pad_x, pad_y = CAPTION_PAD
    box_w, box_h = round(text_w) + 2 * pad_x, text_h + 2 * pad_y
    x0 = (image.width - box_w) // 2
    y0 = image.height - CAPTION_MARGIN_BOTTOM - box_h
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle((x0, y0, x0 + box_w, y0 + box_h), radius=CAPTION_RADIUS, fill=CAPTION_FILL)
    x = float(x0 + pad_x)
    baseline = y0 + pad_y + ascent
    for ch, f, adv in glyphs:
        draw.text((x, baseline), ch, font=f, fill=CAPTION_TEXT, anchor="ls")
        x += adv
    return Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")


def build_gif() -> None:
    manifest = load_manifest("gif")
    src_dir = CAPTURE_ROOT / "gif"
    font = CaptionFont(CAPTION_FONT_SIZE)
    rgb_frames: list[Image.Image] = []
    durations: list[int] = []
    for entry in manifest["frames"]:
        img = square_corners(Image.open(src_dir / entry["file"]))
        height = round(img.height * GIF_WIDTH / img.width)
        img = img.resize((GIF_WIDTH, height), Image.Resampling.LANCZOS)
        if entry["caption"]:
            img = draw_caption(img, entry["caption"], font)
        rgb_frames.append(img)
        hold = int(entry["holdMs"])
        durations.append(round(hold / GIF_DURATION_UNIT_MS) * GIF_DURATION_UNIT_MS)
    # One palette for all frames, so colours do not shift from frame to frame.
    # Octree keeps small saturated areas (the toolbar icon) truer than median cut.
    mosaic = Image.new("RGB", (GIF_WIDTH, sum(f.height for f in rgb_frames)))
    y = 0
    for f in rgb_frames:
        mosaic.paste(f, (0, y))
        y += f.height
    palette = mosaic.quantize(colors=GIF_COLORS, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    frames = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in rgb_frames]
    GIF_OUT.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        GIF_OUT,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=GIF_LOOP_FOREVER,
        optimize=True,
        disposal=1,
    )
    size_kb = GIF_OUT.stat().st_size / 1024
    print(f"wrote {GIF_OUT.relative_to(PROJECT_ROOT)} ({len(frames)} frames, {frames[0].width}x{frames[0].height}, {size_kb:.0f} KiB)")


def build_store() -> None:
    manifest = load_manifest("store")
    src_dir = CAPTURE_ROOT / "store"
    STORE_OUT_DIR.mkdir(parents=True, exist_ok=True)
    for shot in manifest["shots"]:
        img = square_corners(Image.open(src_dir / shot["file"]))
        img = img.resize(STORE_SIZE, Image.Resampling.LANCZOS)
        out = STORE_OUT_DIR / f"{shot['name']}.png"
        img.save(out, optimize=True)
        print(f"wrote {out.relative_to(PROJECT_ROOT)} ({img.width}x{img.height} {img.mode})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=("gif", "store"))
    args = parser.parse_args()
    {"gif": build_gif, "store": build_store}[args.mode]()


if __name__ == "__main__":
    main()
