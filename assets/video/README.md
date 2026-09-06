# Video

**Generated. Do not edit, and do not re-encode by hand.**

Unlike `assets/brand/`, which holds originals, everything here is an output of
[`sites/video`](../../sites/video) — the same relationship `docs/openapi.json` has with the routes.
The compositions are the source; these files are here so that somebody posting to LinkedIn does not
have to install a renderer first.

Six spots, each in three shapes — eighteen masters. All of them are 30fps and exactly 900 frames —
30.00s — H.264, yuv420p, and with no audio track, because they are built for a muted autoplaying
`<video>` and for a social timeline.

| file | | |
|---|---|---|
| `kolibri-30s.mp4` | the product | offline-first, five layouts, quick add, dependencies, MCP |
| `tasks-30s.mp4` | tasks | one line to file it, every field, the query |
| `pages-30s.mp4` | pages | markdown, wiki links, two at once, comments, history |
| `signup-30s.mp4` | sign-up | the first account, invites, SSO, two-factor, sessions |
| `workspace-30s.mp4` | workspace | what belongs to one, roles, feature switches, teams |
| `hierarchy-30s.mp4` | hierarchy | the six levels, and the two rules that keep them honest |

Each of those is 1920×1080. Beside each sits a `…-vertical.mp4` at 1080×1920 and a `…-feed.mp4` at
1080×1350 — re-laid-out for the shape rather than letterboxed into it. `poster.jpg`,
`poster-vertical.jpg` and `poster-feed.jpg` are frame 870 of the flagship spot, for
`<video poster="…">`.

| shape | | |
|---|---|---|
| 16:9 | 1920×1080 | a landing page, YouTube, a slide |
| 9:16 | 1080×1920 | a story, a reel, a short |
| 4:5 | 1080×1350 | the feed post — the tallest thing Instagram and LinkedIn show without cropping |

## Putting them back

Nothing here is edited; all of it is rendered. Delete the lot and this brings it back — the
compositions take no input but the repository, so the frames are the same ones. (The bytes of the
file are the encoder's business, and a different Chromium or ffmpeg build may spell them
differently.)

```bash
cd sites/video
npm install                     # Remotion, React, Inter and JetBrains Mono

# Six spots × three shapes. Every spot has a plain, a :vertical and a :feed script.
npm run build                   npm run build:vertical                   npm run build:feed
npm run build:tasks             npm run build:tasks:vertical             npm run build:tasks:feed
npm run build:pages             npm run build:pages:vertical             npm run build:pages:feed
npm run build:signup            npm run build:signup:vertical            npm run build:signup:feed
npm run build:workspace         npm run build:workspace:vertical         npm run build:workspace:feed
npm run build:hierarchy         npm run build:hierarchy:vertical         npm run build:hierarchy:feed

npm run poster                  npm run poster:vertical                  npm run poster:feed

cp out/*.mp4 out/*.jpg ../../assets/video/
```

Each render takes about two minutes and needs a Chromium. Remotion downloads its own on the first
one; where that download cannot reach `remotion.media`, point `CHROMIUM_PATH` at a Chromium already
on disk — the same variable `scripts/responsive.mjs` and its neighbours read:

```bash
CHROMIUM_PATH=/path/to/headless_shell npm run build
```

To see one before committing to a full render, `npm run dev` opens the Remotion studio with all
eighteen compositions in it, scrubbable frame by frame.

This folder is in the root `.dockerignore`: no image stage copies it, and fifty megabytes of H.264
in every build context is a cost with nothing on the other side of it.

`sites/video/README.md` has the six storyboards, what is a real screenshot and what is drawn, and
why none of them has a soundtrack.
