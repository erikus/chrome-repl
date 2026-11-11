# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==12.0.0", "imageio-ffmpeg==0.6.0"]
# ///
"""Turn the window captures from scripts/demo.mjs into images and a video.

Usage:
    uv run scripts/demo_assemble.py gif    # .cache/demo/gif/   -> docs/demo.gif
    uv run scripts/demo_assemble.py video  # .cache/demo/gif/   -> dist/demo.mp4
    uv run scripts/demo_assemble.py store  # .cache/demo/store/ -> docs/store/screenshot-*.png

The video is built from the same recording as the GIF, at full capture
resolution, centred on a 16:9 canvas in the demo backdrop colour (H.264,
yuv420p, constant frame rate; for uploading, so it lives in the gitignored
dist/). ffmpeg comes from the imageio-ffmpeg wheel, nothing system-wide.

Every capture is the browser window's screen region, so it carries the
window's rounded corners (with a sliver of whatever is behind them) and its
1 px outline. Both are trimmed: the outline is cropped off and the corners are
squared off with the colour just inside them. The GIF gets a key caption
(the shortcut each step stands for) drawn bottom-centre.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageStat

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CAPTURE_ROOT = PROJECT_ROOT / ".cache" / "demo"
GIF_OUT = PROJECT_ROOT / "docs" / "demo.gif"
STORE_OUT_DIR = PROJECT_ROOT / "docs" / "store"
VIDEO_OUT = PROJECT_ROOT / "dist" / "demo.mp4"

# In capture pixels (2x points on Retina).
EDGE_INSET_PX = 2  # window outline
CORNER_RADIUS_PX = 30  # macOS window corner, a little generous
# Where the corner fill colour is sampled, measured from each corner (x, y).
TOP_CORNER_SAMPLE = (CORNER_RADIUS_PX, CORNER_RADIUS_PX // 2)
BOTTOM_CORNER_SAMPLE = (CORNER_RADIUS_PX, CORNER_RADIUS_PX // 2)

# Empty tab-strip area (left, top, right, bottom): right of the "+" button,
# left of the window edge, above the toolbar.
TAB_STRIP_BAND_PX = (900, 16, 1560, 64)
TAB_STRIP_MAX_STDDEV = 3.0  # clean captures measure about 1; text behind is far above

STORE_SIZE = (1280, 800)  # Chrome Web Store screenshot size
GIF_WIDTH = 960
GIF_COLORS = 256
GIF_DURATION_UNIT_MS = 10  # GIF delays are stored in centiseconds
GIF_LOOP_FOREVER = 0
# Grey frame so the GIF stands apart from the README's other images. The README
# shows the GIF at half its width, so 2 px here is 1 px on the page.
GIF_BORDER_PX = 2
GIF_BORDER_RGB = (0xD0, 0xD7, 0xDE)  # GitHub's light-theme border grey

VIDEO_SIZE = (1920, 1080)  # 16:9; the 2x capture (about 1596x996) fits unscaled
VIDEO_FPS = 30
VIDEO_BACKGROUND_RGB = (0xD6, 0xD6, 0xD6)  # BACKDROP_COLOR in scripts/demo.mjs
VIDEO_CRF = 18  # x264 quality; visually lossless for UI captures
VIDEO_PRESET = "slow"
VIDEO_KEYFRAME_INTERVAL = VIDEO_FPS  # one keyframe per second
MS_PER_S = 1000

# Key caption, in GIF pixels (scaled up with the image for the video).
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


def checked_capture(path: Path) -> Image.Image:
    """Open a capture; fail if anything shows through the translucent tab strip.

    The empty tab-strip area right of the "+" button should be a flat colour
    (it blurs the opaque backdrop window from scripts/demo.mjs). Text or other
    windows behind it show up as luminance variance.
    """
    image = Image.open(path)
    band = image.convert("L").crop(TAB_STRIP_BAND_PX)
    stddev = ImageStat.Stat(band).stddev[0]
    if stddev > TAB_STRIP_MAX_STDDEV:
        raise SystemExit(
            f"{path.name}: tab strip is not uniform (luminance stddev {stddev:.1f} > {TAB_STRIP_MAX_STDDEV}); "
            "something behind the Chrome window shows through"
        )
    return image


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

    def __init__(self, size: int, letter_spacing: float = CAPTION_LETTER_SPACING) -> None:
        self.letter_spacing = letter_spacing
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
        return [(ch, f := self.font_for(ch), f.getlength(ch) + self.letter_spacing) for ch in text]


def draw_caption(image: Image.Image, text: str, font: CaptionFont, scale: float) -> Image.Image:
    """Draw the key caption bottom-centre; `scale` maps GIF pixels to `image` pixels."""
    glyphs = font.layout(text)
    text_w = sum(adv for _, _, adv in glyphs) - font.letter_spacing
    ascent, descent = font.fonts[0].getmetrics()
    text_h = ascent + descent
    pad_x, pad_y = round(CAPTION_PAD[0] * scale), round(CAPTION_PAD[1] * scale)
    box_w, box_h = round(text_w) + 2 * pad_x, text_h + 2 * pad_y
    x0 = (image.width - box_w) // 2
    y0 = image.height - round(CAPTION_MARGIN_BOTTOM * scale) - box_h
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    radius = round(CAPTION_RADIUS * scale)
    draw.rounded_rectangle((x0, y0, x0 + box_w, y0 + box_h), radius=radius, fill=CAPTION_FILL)
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
        img = square_corners(checked_capture(src_dir / entry["file"]))
        height = round(img.height * GIF_WIDTH / img.width)
        img = img.resize((GIF_WIDTH, height), Image.Resampling.LANCZOS)
        if entry["caption"]:
            img = draw_caption(img, entry["caption"], font, scale=1.0)
        img = ImageOps.expand(img, border=GIF_BORDER_PX, fill=GIF_BORDER_RGB)
        rgb_frames.append(img)
        hold = int(entry["holdMs"])
        durations.append(round(hold / GIF_DURATION_UNIT_MS) * GIF_DURATION_UNIT_MS)
    # One palette for all frames, so colours do not shift from frame to frame.
    # Octree keeps small saturated areas (the toolbar icon) truer than median cut.
    mosaic = Image.new("RGB", (rgb_frames[0].width, sum(f.height for f in rgb_frames)))
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


def build_video() -> None:
    """Full-resolution MP4 of the GIF recording, padded to VIDEO_SIZE."""
    manifest = load_manifest("gif")
    src_dir = CAPTURE_ROOT / "gif"
    entries = manifest["frames"]
    if not entries:
        raise SystemExit("frames.json lists no frames")
    windows = [square_corners(checked_capture(src_dir / e["file"])) for e in entries]
    win_w, win_h = windows[0].size
    if any(w.size != (win_w, win_h) for w in windows):
        raise SystemExit("captures differ in size; re-record with `node scripts/demo.mjs gif`")
    canvas_w, canvas_h = VIDEO_SIZE
    if win_w > canvas_w or win_h > canvas_h:
        raise SystemExit(f"capture {win_w}x{win_h} does not fit the {canvas_w}x{canvas_h} video frame")
    scale = win_w / GIF_WIDTH
    font = CaptionFont(round(CAPTION_FONT_SIZE * scale), CAPTION_LETTER_SPACING * scale)
    offset = ((canvas_w - win_w) // 2, (canvas_h - win_h) // 2)

    ffmpeg_cmd = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{canvas_w}x{canvas_h}", "-r", str(VIDEO_FPS), "-i", "-",
        # sRGB captures -> BT.709 limited range, tagged so players don't guess.
        "-vf", "scale=out_color_matrix=bt709:out_range=tv,"
        "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
        "-c:v", "libx264", "-preset", VIDEO_PRESET, "-crf", str(VIDEO_CRF), "-tune", "stillimage",
        "-g", str(VIDEO_KEYFRAME_INTERVAL), "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-r", str(VIDEO_FPS), "-movflags", "+faststart",
        str(VIDEO_OUT),
    ]
    VIDEO_OUT.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    elapsed_ms = 0
    written = 0
    try:
        for entry, window in zip(entries, windows, strict=True):
            if entry["caption"]:
                window = draw_caption(window, entry["caption"], font, scale=scale)
            canvas = Image.new("RGB", VIDEO_SIZE, VIDEO_BACKGROUND_RGB)
            canvas.paste(window, offset)
            raw = canvas.tobytes()
            # Frame counts from cumulative time, so rounding never drifts.
            elapsed_ms += int(entry["holdMs"])
            end_frame = round(elapsed_ms * VIDEO_FPS / MS_PER_S)
            for _ in range(end_frame - written):
                proc.stdin.write(raw)
            written = end_frame
    finally:
        proc.stdin.close()
        returncode = proc.wait()
    if returncode != 0:
        raise SystemExit(f"ffmpeg failed with exit code {returncode}")
    size_mib = VIDEO_OUT.stat().st_size / (1024 * 1024)
    print(
        f"wrote {VIDEO_OUT.relative_to(PROJECT_ROOT)} ({canvas_w}x{canvas_h}, {VIDEO_FPS} fps, "
        f"{written} frames, {written / VIDEO_FPS:.2f} s, {size_mib:.1f} MiB)"
    )


def build_store() -> None:
    manifest = load_manifest("store")
    src_dir = CAPTURE_ROOT / "store"
    STORE_OUT_DIR.mkdir(parents=True, exist_ok=True)
    for shot in manifest["shots"]:
        img = square_corners(checked_capture(src_dir / shot["file"]))
        img = img.resize(STORE_SIZE, Image.Resampling.LANCZOS)
        out = STORE_OUT_DIR / f"{shot['name']}.png"
        img.save(out, optimize=True)
        print(f"wrote {out.relative_to(PROJECT_ROOT)} ({img.width}x{img.height} {img.mode})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    builders = {"gif": build_gif, "video": build_video, "store": build_store}
    parser.add_argument("mode", choices=tuple(builders))
    args = parser.parse_args()
    builders[args.mode]()


if __name__ == "__main__":
    main()
