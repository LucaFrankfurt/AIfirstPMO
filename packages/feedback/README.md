# @kolibri-day/feedback

In-app feedback with a screenshot of the current view, delivered to
[Kolibri](https://kolibri.day) — or to any other tracker behind the same `FeedbackTarget`
interface.

Your users click a button, see the screenshot that will be attached, write what went
wrong, and the report lands as a task in your Kolibri project: title, description, the
facts your server knows about them, what their browser reported, and the image. The
package contains everything that does not depend on your app — capture, the wire
protocol, validation, the delivery rules and the Kolibri client. Your app keeps only its
own concerns: who the reporter is, where reports are stored, which queue retries them,
and what the dialog looks like.

It was extracted from a production CRM, where it files reports into a self-hosted
Kolibri. MIT licensed, like Kolibri itself.

## How it fits together

```
 browser                         app server                     worker / queue
 ───────                         ──────────                     ──────────────
 FeedbackReporterProvider        POST /api/feedback             dispatchFeedback(id)
   openFeedback() ── capture ─┐    readFeedbackForm(request)      store.load(id)
   dialog (your markup)       │    parseFeedbackInput(...)        target.submit(report)
   submitFeedback() ──────────┴──▶ + reporter from YOUR session   store.markSubmitted / recordFailure
                                   store + enqueue(id)  ────────▶ (retry on transient errors)
                                                                       │
                                                                       ▼
                                                          Kolibri: POST …/tasks  (id = report id)
                                                                   POST …/files  (raw screenshot)
```

| Entry point | Runs in | Contents |
|---|---|---|
| `@kolibri-day/feedback` | anywhere | `FeedbackReport` and `FeedbackTarget` types, `FeedbackTargetError`, the Markdown formatter, the privacy-notice helpers, `en`/`de` messages, `FakeFeedbackTarget` |
| `@kolibri-day/feedback/browser` | browser | `captureViewport`, `collectClientContext`, `submitFeedback`, `FeedbackReporterController` (framework-agnostic state) |
| `@kolibri-day/feedback/react` | React 18+ | `FeedbackReporterProvider`, `useFeedback`, `useFeedbackReporter` — state only, no markup |
| `@kolibri-day/feedback/server` | Node 20+ / any `fetch` runtime | `readFeedbackForm`, `parseFeedbackInput`, `dispatchFeedback` + `FeedbackStore`, `resolveFeedbackTarget`, `describeFeedbackTarget` |
| `@kolibri-day/feedback/kolibri` | Node 20+ / any `fetch` runtime | `KolibriFeedbackTarget`, `kolibriConfigFromEnv` |
| `kolibri-feedback-preflight` (bin) | Node 20+ | checks a live Kolibri instance before you go live |

The package ships ES modules and CommonJS with type declarations.

## Install

```bash
npm install @kolibri-day/feedback
# for the screenshot (optional peer dependencies, loaded lazily on first capture)
npm install modern-screenshot html2canvas
```

`react` is an optional peer dependency, needed only for `./react`.

## Usage

### 1. Browser: provider, triggers, dialog

```tsx
'use client';
import { FeedbackReporterProvider, useFeedback, useFeedbackReporter } from '@kolibri-day/feedback/react';
import { collectClientContext, submitFeedback } from '@kolibri-day/feedback/browser';
import { screenshotDefaultOn, screenshotNotice, type FeedbackTargetDescriptor } from '@kolibri-day/feedback';

export function Shell({ target, children }: { target: FeedbackTargetDescriptor; children: React.ReactNode }) {
  return (
    <FeedbackReporterProvider>
      {children}
      <ReportButton />
      <ReportDialog target={target} />
    </FeedbackReporterProvider>
  );
}

function ReportButton() {
  const { openFeedback } = useFeedback(); // stable; a no-op outside the provider
  return <button data-feedback-redact onClick={openFeedback}>Feedback</button>;
}

function ReportDialog({ target }: { target: FeedbackTargetDescriptor }) {
  const { open, capture, close, waitForCapture } = useFeedbackReporter();
  // Render your own dialog. Its panel AND its backdrop need `data-feedback-redact`,
  // because it opens while the capture is still running.
  // capture.status: 'capturing' → 'ready' (capture.blob) | 'failed'
  // On submit (await waitForCapture() if the reporter outran the renderer):
  //   await submitFeedback('/api/feedback', { kind, message, clientContext: collectClientContext(), screenshot })
  // Default the screenshot checkbox to screenshotDefaultOn(target) and show screenshotNotice(target).
  return null;
}
```

**Redaction.** Anything carrying `data-feedback-redact` is left out of the screenshot:
the dialog and its backdrop, the trigger, a menu that is still animating closed, and any
data that must never appear in a ticket. Configure a different attribute with
`captureOptions: { redactAttribute }`.

**What is captured:** the visible viewport (not the full page), rendered from the DOM —
first with modern-screenshot, then with html2canvas if the first result is blank or
unreadable. The longest edge is capped at 2560 px and the image is encoded as WebP (JPEG
where the browser cannot encode WebP), stepping quality down to stay near 1 MB. The
browser data collected is URL, title, viewport, screen, DPR, user agent, language,
timezone, online status, connection type and the client clock. It never includes
storage, cookies or console output.

### 2. Server: accept a report

```ts
import { readFeedbackForm, parseFeedbackInput, FeedbackInputError } from '@kolibri-day/feedback/server';

export async function POST(request: Request) {
  const user = await getSessionUser(request); // YOUR session — never the request body
  if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const input = parseFeedbackInput(await readFeedbackForm(request), { kinds: ['BUG', 'IDEA', 'OTHER'] });
    const id = crypto.randomUUID(); // becomes the Kolibri task id — must be a UUID
    await db.transaction(async (tx) => {
      await tx.insertReport({ id, ...input, reporterId: user.id, reporterName: user.name });
      await tx.enqueue('submit_feedback', { id }); // same transaction: no report without a job
    });
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (e) {
    if (e instanceof FeedbackInputError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
```

The wire format has no identity field, so a client cannot claim to be someone else. Add
a per-reporter rate limit: the endpoint accepts uploads of several hundred KB.

### 3. Worker: deliver it

```ts
import { resolveFeedbackTarget, dispatchFeedback, type FeedbackStore } from '@kolibri-day/feedback/server';

const { target, warning } = resolveFeedbackTarget(process.env); // never throws
if (warning) console.warn(warning);

const store: FeedbackStore = {
  async load(id) {
    // → { report, status: 'pending' | 'submitted' | 'failed', externalId } | null
  },
  async markSubmitted(id, update) {
    // status = submitted, store update.externalId / externalUrl, AND drop the screenshot bytes
  },
  async recordFailure(id, update) {
    // lastError = update.message; persist update.externalId; status = failed if update.permanent
  },
};

queue.handle('submit_feedback', ({ id }) => dispatchFeedback(id, { store, target }));
```

`dispatchFeedback` resolves on success, when there is nothing to do, and on a
**permanent** failure (it is recorded, and retrying cannot help). It throws on a
**transient** failure, so your queue backs off and retries. After a successful delivery
your store must delete the stored screenshot: the tracker has it, and a second copy is
just more exposure.

**Without a queue** you can call `target.submit(report)` right after storing. That is
simpler, but a report is then delivered only if the tracker is reachable at that moment,
and people tend to report bugs precisely when something is down.

## Configuration

| Variable | Where | Value |
|---|---|---|
| `FEEDBACK_TARGET` | web + worker | `kolibri` or `fake`. If unset: `fake` in development, and in production a target that fails every report loudly |
| `KOLIBRI_API_URL` | worker | Kolibri's origin, e.g. `https://kolibri.example.com`. Not an `/api` path |
| `KOLIBRI_TOKEN` | worker | a confined `kol_…` token with the `write` scope. **Secret** |
| `KOLIBRI_WORKSPACE_ID` | worker | workspace **UUID** (a slug is refused) |
| `KOLIBRI_PROJECT_ID` | worker | project **UUID** (a project key is refused) |

The web tier only needs `FEEDBACK_TARGET`. `describeFeedbackTarget()` names the
destination for the privacy notice without credentials.

## Kolibri setup

1. **Minimum Kolibri version.** Use an instance that scopes attachments by the project of
   the task they belong to ("A private project's comments, attachments and files were the
   whole workspace's"). On older instances any workspace member can fetch any screenshot,
   and a private project protects nothing.
2. **A feedback project whose audience is right.** Everyone who can see the project can
   open every screenshot in it. Use a private project with a deliberate member list, or a
   public one in a workspace whose members are exactly that audience. Kolibri has no UI
   for project members; add them with
   `POST /api/workspaces/{ws}/project-members {"project_id", "user_id", "role"}`.
3. **A dedicated account** with role ≥ `member` in the workspace (guests cannot upload),
   and also a member of the project, because the preflight reads back.
4. **A confined write token**, minted as that account:
   `POST /api/tokens {"name":"…","workspaceId":"<uuid>","confined":true,"scopes":"write","expiresInDays":90}`.
   A confined token sees one workspace and cannot mint further tokens.
5. **Run the preflight** with the variables above:

   ```bash
   npx kolibri-feedback-preflight            # leaves the test task for review
   npx kolibri-feedback-preflight --cleanup  # deletes it afterwards
   ```

   It checks the token and its confinement, resolves workspace and project, and **prints
   who can open screenshots**. It then creates a task through the real
   `KolibriFeedbackTarget`, uploads a ~380 KB WebP, checks the stored size for truncation,
   and fetches the file back. Exit code 0 means ready.
6. Rotate any token that was pasted somewhere while troubleshooting.

Delivery is idempotent. The report id is sent as the task id, and Kolibri treats a
create on an existing id as an update. An identical re-upload returns the existing
attachment. A retry therefore never duplicates a ticket or a screenshot. The details are
in [`docs/setaside-feedback-api.md`](../../docs/setaside-feedback-api.md).

## Languages

English is the default; German ships too. Pass `messages`:

```ts
import { de, en } from '@kolibri-day/feedback';
resolveFeedbackTarget(process.env, { messages: de, kindLabels: { BUG: 'Bug', IDEA: 'Idee', OTHER: 'Sonstiges' } });
parseFeedbackInput(input, { kinds, messages: de });
screenshotNotice(target, de);

// Override single strings by spreading:
const mine = { ...en, notice: { ...en.notice, selfHosted: (label: string) => `… ${label} …` } };
```

`messages` covers the ticket body, the privacy notice, validation errors, Kolibri errors
and configuration warnings. Your dialog's own copy remains yours. The preflight speaks
English.

## Security and privacy notes

- **The ticket body is Markdown and is not escaped.** That is correct for Kolibri, whose
  renderer escapes all input. Escaping it here would double-escape. A target that renders
  raw HTML must **not** reuse `buildDescriptionMarkdown` as it is.
- **Server-derived and client-reported data are kept apart.** The ticket has one table
  for what the server knows (reporter, `serverContext`, timestamps) and one, labelled as
  unverified, for what the browser reported.
- **Where the screenshot goes decides the default.** For a `self_hosted` target the
  screenshot is attached by default. For a `third_party` target the reporter has to opt
  in, and the notice says the data leaves your infrastructure. A new target has to state
  which one it is.
- **Client context is untrusted.** It is limited to scalar values, 40 keys and 2,000
  characters per value, and is never parsed as anything else.

## Development

This package lives in the Kolibri repository and follows its rules (`CLAUDE.md` at the
root): sources under `src/<ring>/<module>/`, `.ts` imports that Node 22 runs directly,
`node:test`. Unlike the other four packages it is built to JavaScript, because it runs in
other people's bundlers and Node versions.

```
src/kernel/feedback/   the report, the target contract, formatter, messages, input, delivery rules
src/adapters/kolibri/  the Kolibri target, its env vars, the preflight
src/adapters/capture/  screenshot, browser facts, reporter state, the submit
src/adapters/react/    the React bindings
src/*.ts               one entry point per published sub-path, the resolver, the CLI
```

```bash
npm run test:feedback                          # from the repository root
npm run typecheck                              # includes this package
npm run build -w @kolibri-day/feedback         # dist/esm + dist/cjs
```

The renderers need a real layout engine and are not unit-tested. Everything around them
is: the downscale arithmetic, the encoder's choice of format (including the Safari case
where WebP comes back as PNG), the blank-canvas check, and the reporter state machine.

## Releasing

Releases are published from GitHub Actions with npm's trusted publishing — no npm token is
stored anywhere, and every version the workflow publishes carries a provenance statement
linking it to the commit and the run that built it (npm adds it automatically; a manual
publish from a laptop has none, which is why only the first version is published that
way).

1. Bump `version` in `packages/feedback/package.json` and merge that to `main`.
2. Push a tag `feedback-v<version>` on that commit, e.g. `feedback-v0.2.0`.
3. `.github/workflows/release-feedback.yml` checks the tag against the version, runs the
   package's typecheck and tests, builds, and runs `npm publish`.

One-time setup, done once by an owner of the npm organisation `kolibri-day`:

- Publish the very first version by hand (npm can only attach a trusted publisher to a
  package that exists): `npm run build -w @kolibri-day/feedback`, then
  `npm publish -w @kolibri-day/feedback --access public` while logged in.
- On npmjs.com, open the package → Settings → Trusted publishing, choose GitHub Actions,
  and enter repository `LucaFrankfurt/AIfirstPMO` and workflow `release-feedback.yml`.
- Optionally, under Settings → Publishing access, require two-factor authentication and
  disallow tokens, so the workflow is the only way a version can be published.
