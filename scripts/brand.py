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

**The native shells are fed from here too**, when they are in the tree — the
launcher icons, the home-screen icon and both launch screens. Xcode and Android
Studio each offer a wizard for this, and using either would have made the app's
mark come from a different place than the web's, drifting the first time only
one of them was re-run.

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
IOS = ROOT / "packages" / "web" / "ios" / "App" / "App" / "Assets.xcassets"
ANDROID = ROOT / "packages" / "web" / "android" / "app" / "src" / "main" / "res"

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

# Every platform that masks an icon promises the same shape: a circle, centred,
# of some fraction of the canvas. What differs is the fraction, so the rule is
# written once and asked three times rather than three numbers being kept.
#
# A square inscribed in a circle of diameter `d` has side `d / sqrt(2)`. The
# silhouette has empty corners, which buys a little past the strict fit — the
# leniency below is what the PWA maskable icon was already using, reached by
# eye, and keeping it as a factor is what makes the other two derivable rather
# than guessed.
LENIENCE = 1.025


def fits(circle: float) -> float:
    """Fill ratio for art that must survive a circular crop of `circle`."""
    return round(circle / 2 ** 0.5 * LENIENCE, 3)


# The PWA: Android may crop a maskable icon to a circle across 80% of the canvas.
MASKABLE_FILL = fits(0.80)  # 0.58, the value this was before it was derived

# An adaptive launcher icon is a 108dp canvas of which the central 72dp is the
# only part guaranteed to survive the launcher's mask.
ADAPTIVE_FILL = fits(72 / 108)

# A legacy round icon is cropped to a circle across the whole canvas.
ROUND_FILL = fits(1.0)

# Android density buckets, as multiples of the mdpi baseline. A launcher icon
# is 48dp and an adaptive icon's canvas 108dp, so every size below is one of
# those two times one of these.
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


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


def circular_mask(size: int) -> Image.Image:
    from PIL import ImageDraw

    # Supersampled for the same reason `rounded_mask` is: PIL does not
    # antialias, and an aliased circle at 192px has visible steps on it.
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * scale - 1, size * scale - 1), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def masked(tile: Image.Image, mask: Image.Image) -> Image.Image:
    out = Image.new("RGBA", tile.size, (0, 0, 0, 0))
    out.paste(tile, (0, 0), mask)
    return out


def compose(bird: Image.Image, size: int, fill: float, rounded: bool, ground=TILE_BG) -> Image.Image:
    """Centre the bird on a tile, at `fill` of the canvas along its long edge.

    `ground` is transparent for exactly one caller: an Android adaptive icon
    supplies its background as a separate layer, and painting the tile into the
    foreground would hide it.
    """
    target = size * fill
    ratio = bird.width / bird.height
    h = round(target)
    w = round(target * ratio)
    if w > target:  # never let the wider axis escape the fill box
        w = round(target)
        h = round(target / ratio)

    art = bird.resize((w, h), Image.LANCZOS)
    tile = Image.new("RGBA", (size, size), ground)
    tile.alpha_composite(art, ((size - w) // 2, (size - h) // 2))

    if rounded:
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out.paste(tile, (0, 0), rounded_mask(size, round(size * RADIUS_RATIO)))
        return out
    return tile


def on_canvas(art: Image.Image, w: int, h: int, ground) -> Image.Image:
    """`art` centred on a rectangle of `ground`.

    A splash is the one place the canvas is not a square: Android sets the PNG
    as the launch window's `background`, which stretches it to the screen, so
    each drawable is already the shape of the screen it is for.
    """
    canvas = Image.new("RGBA", (w, h), ground)
    canvas.alpha_composite(art, ((w - art.width) // 2, (h - art.height) // 2))
    return canvas


def quantized(img: Image.Image) -> Image.Image:
    return img.quantize(colors=PALETTE, method=Image.FASTOCTREE)


def report(path: Path, note: str) -> None:
    print(f"  {str(path.relative_to(ROOT)):<40} {path.stat().st_size / 1024:6.1f} KB  {note}")


def write_png(img: Image.Image, name: str, into: Path = PUBLIC, palette: bool = True) -> None:
    """A palette by default; see `PALETTE` for why that is nearly free here.

    `palette=False` is for the one image whose shape *is* its alpha channel. A
    palette carries transparency as one byte per entry, so quantising an
    anti-aliased outline collapses it — the adaptive icon's foreground came out
    with ten alpha steps along the bird's keyline, which is a visible stair on a
    432px edge against a white layer underneath.
    """
    path = into / name
    (img if not palette else quantized(img)).save(path, optimize=True)
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


# How much of a launch screen the tile spans, across the shorter side. Small:
# a splash is a held breath, not a poster.
SPLASH_FILL = 0.30

# The ground behind it, which is the one the web manifest already declares — and
# `capacitor.config.ts` gives the WebView the same value, so the launch screen,
# the frame after it and the PWA's own splash are all one colour.
#
# It is not white, and the tile on it is, which is the pair the manifest already
# chose: the bird is drawn with a heavy black keyline that disappears on a dark
# ground with nothing behind it. Painting the whole screen white instead would
# make a light-mode start seamless and a dark-mode one flash twice; this way it
# flashes once, at the end, and never during the wait.
SPLASH_GROUND = (11, 13, 18, 255)  # #0b0d12

# The iOS launch image is a square, scaled `aspectFill` into a screen taller
# than it is wide — so it is the screen's *height* the square is matched to, and
# what you see across the width is only `w/h` of it. Undoing that here is what
# makes the mark come out the same size on both platforms.
PHONE_RATIO = 9 / 19.5
IOS_SPLASH_FILL = round(SPLASH_FILL * PHONE_RATIO, 3)


def write_app_icons(bird: Image.Image) -> None:
    """The launcher and home-screen icons for the two native shells.

    Not a separate pipeline: these come off the same source art and the same
    `fits()` rule as the PWA's, which is the whole reason they live here rather
    than in whatever wizard Xcode and Android Studio each offer. The projects
    shipped with Capacitor's own mark on them; this is what replaces it.
    """
    # iOS asks for one 1024px icon and rounds it itself, so this is full bleed —
    # a rounded source gets rounded twice into a visibly clipped corner. RGB
    # rather than the palette everything else uses, because the App Store
    # refuses an icon with an alpha channel and RGBA is how it would get one.
    icon = compose(bird, 1024, ANY_FILL, rounded=False).convert("RGB")
    path = IOS / "AppIcon.appiconset" / "AppIcon-512@2x.png"
    icon.save(path, optimize=True)
    report(path, "1024x1024, no alpha")

    # Android wants three icons per density: the adaptive foreground, and the
    # two legacy shapes for launchers older than API 26. The adaptive
    # background is a flat white in `values/ic_launcher_background.xml`, which
    # is the same decision the tile makes and for the same reason.
    for bucket, scale in DENSITIES.items():
        into = ANDROID / f"mipmap-{bucket}"
        legacy = round(48 * scale)
        write_png(compose(bird, legacy, ANY_FILL, rounded=True), "ic_launcher.png", into=into)
        write_png(
            masked(compose(bird, legacy, ROUND_FILL, rounded=False), circular_mask(legacy)),
            "ic_launcher_round.png", into=into,
        )
        write_png(
            compose(bird, round(108 * scale), ADAPTIVE_FILL, rounded=False, ground=(0, 0, 0, 0)),
            "ic_launcher_foreground.png", into=into, palette=False,
        )


def write_splashes(bird: Image.Image) -> None:
    """The launch screens, at whatever sizes the native projects already hold.

    The sizes are read off the files rather than listed here. Each platform
    picks a splash by rules of its own — Android by orientation and density,
    iOS by a scale in `Contents.json` — and a list kept here would be a second
    copy of those rules, wrong the first time either template changed.
    """
    def splash(w: int, h: int, fill: float) -> Image.Image:
        # The rounded tile rather than the bare bird, which is what the PWA
        # shows on this same ground and for the same reason.
        return on_canvas(compose(bird, round(min(w, h) * fill), ANY_FILL, rounded=True), w, h, SPLASH_GROUND)

    for path in sorted(ANDROID.glob("drawable*/splash.png")):
        with Image.open(path) as existing:
            w, h = existing.size
        write_png(splash(w, h, SPLASH_FILL), path.name, into=path.parent)

    for path in sorted((IOS / "Splash.imageset").glob("*.png")):
        with Image.open(path) as existing:
            w, h = existing.size
        write_png(splash(w, h, IOS_SPLASH_FILL), path.name, into=path.parent)


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

    # The two native shells, if they are in the tree. See docs/mobile.md.
    if IOS.exists() and ANDROID.exists():
        write_app_icons(bird)
        write_splashes(bird)


if __name__ == "__main__":
    main()
