# Social

**Generated. Do not edit, and do not re-crop by hand.**

Like [`assets/video/`](../video), everything here is an output of
[`sites/video`](../../sites/video) rather than an original. The compositions are the source; these
files exist so that somebody posting from a phone does not have to install a renderer first.

Fifty-eight PNGs at **1080×1350** — 4:5, the tallest thing Instagram shows in the feed without
cropping. Six of them are carousels, meant to be uploaded in one post in the order they are
numbered; the seventh folder is not a carousel at all.

| folder | slides | |
|---|---|---|
| `pitch/` | 8 | what Kolibri is — offline-first, five layouts, one line, dependencies, MCP, one command |
| `quickadd/` | 10 | the quick-add syntax, one sigil to a slide — a reference card rather than an advert |
| `offline/` | 8 | the mirror, the queue, the clock, and the merge that is per field rather than per row |
| `hierarchy/` | 8 | the six levels, identifiers, and the two rules that keep them honest |
| `assistant/` | 8 | MCP — the tools, the two transports, the token, and what a connector may do |
| `selfhost/` | 7 | what self-hosting actually costs: one command, one process, one file, one directory |
| `singles/` | 9 | **not a carousel.** Nine standalone posts, for the days between them |

The files in a carousel are numbered from `01`, matching the “1 / 8” drawn on the slide itself, and
zero-padded so that a file picker sorts `10` after `9` rather than after `1`. Upload them in that
order; Instagram keeps it.

`singles/` is nine separate posts that happen to share a folder. They carry no counter and no swipe
chevron, because both would promise a series that is not there.

## Putting them back

```bash
cd sites/video
npm install                 # Remotion, React, Inter and JetBrains Mono
npm run social              # all seven sets → out/social/<set>/<set>-01.png …
npm run social:quickadd     # or one of them

cp -r out/social/*/ ../../assets/social/
```

Where Remotion cannot reach its own Chromium download, point `CHROMIUM_PATH` at one already on
disk — the same variable `scripts/responsive.mjs` and its neighbours read:

```bash
CHROMIUM_PATH=/path/to/headless_shell npm run social
```

**Look before you post.** `npm run social:proof` writes one wide contact sheet per set into
`sites/video/out/social/`, with every slide of the deck side by side and numbered. A carousel goes
wrong in ways a single slide cannot show — one slide crammed while the next is half empty, a
headline that sits at a different height on three of them — and those are comparisons.

The proof sheets are a tool, not an asset: they are written to `out/`, which is not committed.

This folder is in the root `.dockerignore` for the same reason `assets/video` is.

`sites/video/README.md` explains how a still is made out of the films' own widgets, and why there is
no story format here.
