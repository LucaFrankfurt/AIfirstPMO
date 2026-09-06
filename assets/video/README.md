# Video

**Generated. Do not edit, and do not re-encode by hand.**

Unlike `assets/brand/`, which holds originals, everything here is an output of
[`sites/video`](../../sites/video) — the same relationship `docs/openapi.json` has with the routes.
The compositions are the source; these files are here so that somebody posting to LinkedIn does not
have to install a renderer first.

Six spots, each in two shapes — twelve masters. All of them are 30fps and exactly 900 frames —
30.00s — H.264, yuv420p, and with no audio track, because they are built for a muted autoplaying
`<video>` and for a social timeline.

| file | | |
|---|---|---|
| `kolibri-30s.mp4` | 1920×1080 | the product: offline-first, five layouts, quick add, dependencies, MCP |
| `tasks-30s.mp4` | 1920×1080 | what a task is: one line to file it, every field, the query |
| `pages-30s.mp4` | 1920×1080 | what a page is: markdown, wiki links, two at once, comments, history |
| `signup-30s.mp4` | 1920×1080 | getting in: the first account, invites, SSO, two-factor, sessions |
| `workspace-30s.mp4` | 1920×1080 | a workspace: what belongs to one, roles, feature switches, teams |
| `hierarchy-30s.mp4` | 1920×1080 | the six levels, and the two rules that keep them honest |
| `…-vertical.mp4` | 1080×1920 | each of the six again, re-laid-out rather than letterboxed |
| `poster.jpg`, `poster-vertical.jpg` | | frame 870 of the flagship spot, for `<video poster="…">` |

To regenerate after changing a composition:

```bash
cd sites/video
npm install
npm run build              # → out/kolibri-30s.mp4
npm run build:tasks        # and :pages, :signup, :workspace, :hierarchy
npm run build:vertical     # and every :…:vertical beside it
npm run poster
npm run poster:vertical
cp out/*.mp4 out/*.jpg ../../assets/video/
```

`sites/video/README.md` has the three storyboards, what is a real screenshot and what is drawn, and
why none of them has a soundtrack.
