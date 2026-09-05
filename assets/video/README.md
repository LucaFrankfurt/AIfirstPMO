# Video

**Generated. Do not edit, and do not re-encode by hand.**

Unlike `assets/brand/`, which holds originals, everything here is an output of
[`sites/video`](../../sites/video) — the same relationship `docs/openapi.json` has with the routes.
The composition is the source; these two files are here so that somebody posting to LinkedIn does
not have to install a renderer first.

| file | |
|---|---|
| `kolibri-30s.mp4` | 1920×1080, 30fps, exactly 900 frames — 30.00s. H.264, yuv420p, no audio track. |
| `poster.jpg` | Frame 870, for `<video poster="…">` and for anywhere that wants a still. |

To regenerate both after changing the composition:

```bash
cd sites/video
npm install
npm run build     # → out/kolibri-30s.mp4
npm run poster    # → out/poster.jpg
cp out/kolibri-30s.mp4 out/poster.jpg ../../assets/video/
```

`sites/video/README.md` explains the storyboard, what is a real screenshot and what is drawn, and
why the spot has no soundtrack.
