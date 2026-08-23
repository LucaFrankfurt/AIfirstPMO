#!/usr/bin/env python3
"""Generate every icon the app ships from the one piece of source art.

The source is `assets/brand/kolibri-logo-outline.svg`, which is a raster PNG in
an SVG wrapper rather than a real vector — Affinity exported it that way. That
is the whole reason this script exists. There is no vector to scale, so each
size has to be resampled from the 1777x1844 original and quantised, and doing
that by hand across seven files is how they drift apart.

Two things here are not arbitrary and should survive an edit:

**The tile is white.** The bird is drawn with a heavy black keyline, which is
what lets it hold together at 16px — and which vanishes into the page in dark
mode with nothing behind it. `app.css` already reached the same conclusion for
the sign-in mark (`.auth-mark img` sets `background: #fff`), so this matches a
decision the app had already made rather than inventing a second one.

**The three purposes get different geometry**, because the platforms mask them
differently:

  - `any` (favicon, PWA) is rounded here, since nothing rounds it for us.
  - `apple-touch` is a full-bleed square: iOS applies its own corner radius, and
    a rounded source gets rounded twice into a visibly clipped icon.
  - `maskable` is full-bleed *and* pads the bird down to 58%, because Android
    may crop to a circle inscribed in 80% of the canvas. At the `any` scale the
    beak and the tail are outside that circle and get cut off.

Run after changing the source art:  python3 scripts/brand.py
"""

import base64
import io
import re
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "brand" / "kolibri-logo-outline.svg"
PUBLIC = ROOT / "packages" / "web" / "public"
BRAND = ROOT / "assets" / "brand"

TILE_BG = (255, 255, 255, 255)
RADIUS_RATIO = 112 / 512  # carried over from the icon this replaces

# Flat-shaded art, so a palette is nearly free: 128 colours holds the original
# to an RMSE of 2.4/255 (invisible, and all of it on antialiased edges) while
# cutting a 512px frame from 111KB to 18KB. That matters more than usual — the
# service worker precaches these, so every byte ships to every visitor.
PALETTE = 128

# How much of the tile the bird spans. The silhouette runs corner to corner, so
# it reads smaller than the box it sits in and 0.78 left the 16px favicon
# swimming; past 0.90 the beak and the tail tip reach the rounded edge.
ANY_FILL = 0.84

# Android may crop a maskable icon to a circle inscribed in 80% of the canvas.
# A square that fits inside that circle is 0.8/sqrt(2) = 0.566 of the side —
# rounded up a little here, which the empty corners of the silhouette absorb.
MASKABLE_FILL = 0.58


def load_source() -> Image.Image:
    """Pull the embedded PNG back out of the SVG wrapper."""
    svg = SOURCE.read_text()
    blob = re.search(r"base64,([^\"']+)", svg)
    if not blob:
        raise SystemExit(f"no embedded image found in {SOURCE}")
    return Image.open(io.BytesIO(base64.b64decode(blob.group(1)))).convert("RGBA")


def rounded_mask(size: int, radius: int) -> Image.Image:
    from PIL import ImageDraw

    # Supersampled, then scaled down: PIL's rounded_rectangle does not
    # antialias, and an aliased corner is obvious at 512px.
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1), radius=radius * scale, fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def compose(bird: Image.Image, size: int, fill: float, rounded: bool) -> Image.Image:
    """Centre the bird on a tile, at `fill` of the canvas along its long edge."""
    target = size * fill
    ratio = bird.width / bird.height
    h = round(target)
    w = round(target * ratio)
    if w > target:  # never let the wider axis escape the fill box
        w = round(target)
        h = round(target / ratio)

    art = bird.resize((w, h), Image.LANCZOS)
    tile = Image.new("RGBA", (size, size), TILE_BG)
    tile.alpha_composite(art, ((size - w) // 2, (size - h) // 2))

    if rounded:
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(tile, (0, 0), rounded_mask(size, round(size * RADIUS_RATIO)))
        return out
    return tile


def quantized(img: Image.Image) -> Image.Image:
    return img.quantize(colors=PALETTE, method=Image.FASTOCTREE)


def report(path: Path, note: str) -> None:
    print(f"  {str(path.relative_to(ROOT)):<40} {path.stat().st_size / 1024:6.1f} KB  {note}")


def write_png(img: Image.Image, name: str, into: Path = PUBLIC) -> None:
    path = into / name
    quantized(img).save(path, optimize=True)
    report(path, f"{img.width}x{img.height}")


def write_svg(bird: Image.Image, name: str) -> None:
    """The tile as SVG, wrapping a PNG sized for the largest place it is used.

    README renders it at 72px and the sign-in mark at 32px, so 384px covers
    every one of them past 2x. The rounded corner is a real vector `rect`, which
    is why the embedded frame can stay square and small.
    """
    frame = round(384 * ANY_FILL)
    ratio = bird.width / bird.height
    art = bird.resize((round(frame * ratio), frame), Image.LANCZOS)

    buf = io.BytesIO()
    quantized(art).save(buf, format="PNG", optimize=True)
    data = base64.b64encode(buf.getvalue()).decode()

    w = 512 * ANY_FILL * ratio
    h = 512 * ANY_FILL
    x, y = (512 - w) / 2, (512 - h) / 2
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'role="img" aria-label="Kolibri">\n'
        '  <rect width="512" height="512" rx="112" fill="#ffffff"/>\n'
        f'  <image x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
        f'href="data:image/png;base64,{data}"/>\n'
        "</svg>\n"
    )
    path = PUBLIC / name
    path.write_text(svg)
    report(path, "vector tile, 384px art")


def write_badge(bird: Image.Image, name: str, size: int = 96) -> None:
    """Android throws away the colour of a notification badge and keeps the
    alpha, so this ships the silhouette flat white. Handing it the white tile
    instead is how you get a solid square in the status bar."""
    art = bird.resize((round(size * 0.9 * bird.width / bird.height), round(size * 0.9)), Image.LANCZOS)
    badge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    badge.alpha_composite(art, ((size - art.width) // 2, (size - art.height) // 2))
    flat = Image.new("RGBA", badge.size, (255, 255, 255, 0))
    flat.putalpha(badge.getchannel("A"))
    path = PUBLIC / name
    flat.save(path, optimize=True)
    report(path, f"{size}x{size} silhouette")


def write_ico(bird: Image.Image, name: str) -> None:
    """Only the three sizes Windows and legacy browsers actually ask for. The
    larger frames a .ico can hold are dead weight next to `icon.svg`, and they
    were most of the file."""
    base = compose(bird, 256, ANY_FILL, rounded=True)
    path = PUBLIC / name
    base.save(path, sizes=[(16, 16), (32, 32), (48, 48)])
    report(path, "16/32/48")


def main() -> None:
    bird = load_source()
    print(f"source {SOURCE.relative_to(ROOT)}  {bird.width}x{bird.height}")

    write_svg(bird, "icon.svg")
    write_ico(bird, "favicon.ico")

    # `any`: rounded, and the bird runs close to the edge because nothing is
    # going to crop it.
    write_png(compose(bird, 192, ANY_FILL, rounded=True), "icon-192.png")
    write_png(compose(bird, 512, ANY_FILL, rounded=True), "icon-512.png")

    # iOS rounds this itself.
    write_png(compose(bird, 180, ANY_FILL, rounded=False), "apple-touch-icon.png")

    # Android may crop to a circle across 80% of the canvas.
    write_png(compose(bird, 512, MASKABLE_FILL, rounded=False), "icon-maskable-512.png")

    write_badge(bird, "badge-96.png")

    # The bare mark on transparency, for slides, a README banner, a print
    # sheet — anywhere the tile would be wrong. Not under `public/`: nothing in
    # the app requests these, and `public/` is served verbatim.
    for h in (512, 1024, 2048):
        w = round(h * bird.width / bird.height)
        write_png(bird.resize((w, h), Image.LANCZOS), f"kolibri-mark-{h}.png", into=BRAND)


if __name__ == "__main__":
    main()
