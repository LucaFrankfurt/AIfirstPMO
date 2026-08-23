# Brand

Source art. Nothing here is served — the app's icons live in
`packages/web/public/` and are generated from this folder by
[`scripts/brand.py`](../../scripts/brand.py).

```
python3 scripts/brand.py     # needs Pillow
```

## The two originals

Both came out of Affinity as a raster PNG inside an SVG wrapper, so neither is
a real vector and both are around half a megabyte. That is why the icons are
generated rather than linked.

| File | |
|---|---|
| `kolibri-logo-outline.svg` | The bird with a black keyline. **This is the source every icon is built from** — the keyline is what holds the shape together once it is 16px in a browser tab. |
| `kolibri-logo-shadow.svg` | The same bird with a soft drop shadow baked into the pixels instead of the keyline. Kept because it is an original, but not used: a baked shadow is a grey halo on anything that is not white, and the app puts its mark on a dark sidebar and an indigo sign-in panel. |

`kolibri-mark-{512,1024,2048}.png` are generated too — the bird alone, on
transparency, for slides and anywhere a tile would be wrong.

## Why the mark sits on a white tile

The keyline that makes the bird legible at 16px is black, and black on
`#0b0d12` is nothing at all. `app.css` had already reached that conclusion
before this art arrived — `.auth-mark img` sets `background: #fff` — so the
tile matches a decision the app had made rather than adding a second one.

The three purposes are drawn differently on purpose, because the platforms mask
them differently. `scripts/brand.py` explains which and why; the short version
is that a rounded `apple-touch-icon` gets rounded twice by iOS, and a maskable
icon drawn at the normal size loses its beak to Android's circle crop.
