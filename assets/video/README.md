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

To regenerate after changing a composition:

```bash
cd sites/video
npm install
npm run build              # → out/kolibri-30s.mp4
npm run build:tasks        # and :pages, :signup, :workspace, :hierarchy
npm run build:vertical     # and every :…:vertical and :…:feed beside it
npm run poster             # and :vertical, :feed
cp out/*.mp4 out/*.jpg ../../assets/video/
```

`sites/video/README.md` has the three storyboards, what is a real screenshot and what is drawn, and
why none of them has a soundtrack.
