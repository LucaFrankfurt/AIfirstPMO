# Integration prompt for AI coding assistants

Copy everything inside the fence below into your assistant (Claude Code, Cursor, Copilot
Chat, …) while it has your application's repository open. It inspects the repository,
proposes a plan and waits for your answers before it changes anything.

The code in the prompt is checked against the published package: every snippet
type-checks against `@kolibri-day/feedback` 0.1.1.

````text
You are adding an in-app feedback reporter to this application, using the npm package
@kolibri-day/feedback (MIT; source: packages/feedback in github.com/LucaFrankfurt/AIfirstPMO).
A logged-in user clicks a button, sees a screenshot of the current view, writes what went
wrong, and the report becomes a task in a Kolibri project: title, description, facts the
server knows about the user, facts the browser reported, and the screenshot.

Work in four phases and do not skip ahead.

## Phase 1 — inspect, then ask (no edits yet)

Find out and report briefly:
1. Framework and runtime: Next.js (app or pages router), Remix, Express, Vite SPA + API,
   something else. Node version (the package needs Node >= 20). Package manager.
2. How the server learns who the current user is (session/auth helper), and which
   fields exist: id, display name, role, tenant/organisation.
3. Whether there is a database and a background job queue the server already uses.
4. The UI stack: React or not; which dialog/button components the app already has
   (shadcn/ui, MUI, own components); Tailwind or CSS modules.
5. The language the UI speaks (German, English, both) and how text is localised.
6. Where API routes live and how existing ones are written and tested.
7. Anything already named "feedback", to avoid collisions.

Then ask me, with your recommendation for each:
- Delivery mode:
  DIRECT  = the API route sends the report to Kolibri immediately (simple; no database
            needed; if Kolibri is unreachable the user gets an error and can retry).
  DURABLE = store the report, enqueue a job, deliver from the worker with retries
            (needs a table and a queue; nothing is lost while Kolibri is down).
  Recommend DURABLE only if a database and a job queue already exist.
- The report kinds and their labels (default: BUG, IDEA, OTHER).
- The ticket language: English (package default) or German (`de`).
- Which pages get the button (normally every page behind login, never public pages).
- Which screen areas must never appear in a screenshot (salaries, health data, secrets…).

Wait for my answers.

## Phase 2 — install

    <package manager> add @kolibri-day/feedback modern-screenshot html2canvas

`react` is an optional peer (needed for @kolibri-day/feedback/react). Then read
node_modules/@kolibri-day/feedback/README.md once; it is the reference for everything
below. The package ships ESM and CommonJS with types; subpath entry points are
@kolibri-day/feedback, /server, /browser, /react and /kolibri.

## Phase 3 — implement

### 3.1 Configuration (server only)

Read through process.env, document each in .env.example with a comment, never commit a value:
- FEEDBACK_TARGET        kolibri | fake. Unset: fake in development; in production a target
                         that fails every report loudly (never a silent fake).
- KOLIBRI_API_URL        Kolibri origin, e.g. https://kolibri.example.com (NOT an /api path)
- KOLIBRI_TOKEN          secret, confined `write` token
- KOLIBRI_WORKSPACE_ID   workspace UUID (a slug is refused)
- KOLIBRI_PROJECT_ID     project UUID (a project key is refused)
The browser never sees the token and never calls Kolibri.

### 3.2 Server: the target, once per process

    import { de } from '@kolibri-day/feedback';              // only if the tickets are German
    import { resolveFeedbackTarget } from '@kolibri-day/feedback/server';

    export const feedback = resolveFeedbackTarget(process.env, {
      messages: de,                                          // omit for English
      kindLabels: { BUG: 'Bug', IDEA: 'Idee', OTHER: 'Sonstiges' },
    });
    if (feedback.warning) console.warn(`feedback: ${feedback.warning}`);

resolveFeedbackTarget never throws; a misconfiguration yields a target that fails each
report with a readable message, plus `warning`. Put this in exactly one module and import
it everywhere: the package defaults to English, and a second call that forgets
`messages` silently produces English tickets. Add a unit test that pins the language.

### 3.3 Server: the API route

A plain HTTP route that accepts multipart/form-data — in Next.js a route handler
(app/api/feedback/route.ts), NOT a server action (server actions cap bodies at 1 MB).

    import { screenshotFilename, FeedbackTargetError, type FeedbackReport } from '@kolibri-day/feedback';
    import { readFeedbackForm, parseFeedbackInput, FeedbackInputError } from '@kolibri-day/feedback/server';

    const KINDS = ['BUG', 'IDEA', 'OTHER'] as const;

    export async function POST(request: Request): Promise<Response> {
      const user = await getCurrentUser(request);            // THE APP'S OWN SESSION LOOKUP
      if (!user) return Response.json({ error: 'unauthenticated' }, { status: 401 });
      // + a per-user rate limit (e.g. 10/hour): the route accepts several hundred KB.
      try {
        const input = parseFeedbackInput(await readFeedbackForm(request, { messages: de }), {
          kinds: KINDS,
          messages: de,
        });
        const report: FeedbackReport = {
          id: crypto.randomUUID(),                           // MUST be a UUID: it becomes the Kolibri task id
          kind: input.kind,
          message: input.message,
          reporter: { id: user.id, name: user.name, role: user.role },
          serverContext: [['Organisation', user.orgName ?? null]],  // optional trusted facts
          client: input.clientContext,
          attachments: input.screenshot
            ? [{
                filename: screenshotFilename(input.screenshot.contentType),
                contentType: input.screenshot.contentType,
                bytes: input.screenshot.bytes,
              }]
            : [],
          createdAt: new Date(),
          backlink: null,                                    // or { url, label } to an admin view
        };

        // DIRECT mode:
        const result = await feedback.target.submit(report);
        return Response.json({ ok: true, id: report.id, url: result.externalUrl }, { status: 201 });

        // DURABLE mode instead: insert the report and enqueue a job carrying only its id,
        // in ONE transaction, and answer 201 { ok: true, id } — see 3.5.
      } catch (error) {
        if (error instanceof FeedbackInputError) {
          return Response.json({ error: error.message }, { status: error.status });   // 400 / 413
        }
        if (error instanceof FeedbackTargetError) {                                  // DIRECT mode only
          return Response.json({ error: 'Feedback could not be delivered, please try again.' }, { status: 502 });
        }
        throw error;
      }
    }

Rules for this route:
- Identity comes ONLY from the session. The form carries kind, message, clientContext and
  screenshot — nothing else is read, and do not add fields for user, role or tenant.
- Answer `{ error: string }` on failure and `{ id }` on success: the browser half reads
  exactly that.
- Do not escape or sanitise the message. The ticket body is Markdown that Kolibri escapes
  itself; escaping here shows `&lt;` to the reader.

### 3.4 Browser

React (otherwise use FeedbackReporterController from @kolibri-day/feedback/browser, which
has the same state machine with subscribe/getSnapshot):

- Wrap the logged-in layout in <FeedbackReporterProvider>.
- Trigger(s): `const { openFeedback } = useFeedback();` on a button. Give the button the
  attribute data-feedback-redact so it is not in its own screenshot.
- Dialog, built from the app's OWN dialog component:
  `const { open, capture, close, waitForCapture } = useFeedbackReporter();`
  - capture.status is 'capturing' → then 'ready' (capture.blob, width, height) or 'failed'.
    The dialog opens immediately while the screenshot renders; show a spinner, then a
    preview <img> from URL.createObjectURL(capture.blob) (revoke it on change/unmount).
  - Put data-feedback-redact on the dialog panel AND on its backdrop/overlay element.
    Without it, the dialog appears in the screenshot — it opens while the capture runs.
  - Call collectClientContext() when the dialog opens, not on submit.
  - Screenshot checkbox: default screenshotDefaultOn(target); next to it the sentence
    screenshotNotice(target, messages), worded for this app if needed (spread `de`/`en`
    and override `notice`). `target` is a FeedbackTargetDescriptor from
    describeFeedbackTarget(process.env, { messages }) on the SERVER (server component
    prop or a tiny GET endpoint) — never import /server or /kolibri in client code.
  - On submit: if the box is ticked and capture is not 'failed', use capture.blob when
    'ready', else `await waitForCapture()`. Then
    `const result = await submitFeedback('/api/feedback', { kind, message, clientContext, screenshot });`
    result.ok → success message ("sent" in DIRECT mode, "saved" in DURABLE mode);
    otherwise show result.error. submitFeedback rejects only on a network error.
- Add data-feedback-redact to every area named in phase 1 as never-in-a-screenshot.

### 3.5 DURABLE mode only

- A table: id (uuid, primary key), kind, message, reporter id/name/role and any trusted
  facts DENORMALISED (as they were at report time), client_context (json), screenshot
  (bytes, nullable), screenshot_mime, status (pending | submitted | failed),
  external_id, external_url, last_error, created_at, submitted_at.
- A job `submit_feedback` with payload { feedbackReportId } — never the screenshot.
- The worker implements FeedbackStore (load / markSubmitted / recordFailure) and calls
  `dispatchFeedback(id, { store, target: feedback.target })`. It resolves on success,
  nothing-to-do and permanent failure, and throws on transient failure so the queue
  retries. markSubmitted MUST null the screenshot bytes (keep mime and size).
- A daily purge of screenshots older than ~30 days on reports that never got delivered.
- An admin list of reports with status and last_error, so failed deliveries are visible.

## Phase 4 — verify and report

- Tests: the route rejects an unknown kind (400) and an oversized screenshot (413);
  a form field like `role=ADMIN` does not change the stored reporter; the target module
  produces tickets in the agreed language (stub `fetch` via resolveFeedbackTarget's
  `fetch` option and read the request body). Use FEEDBACK_TARGET=fake (FakeFeedbackTarget)
  for anything that must not reach Kolibri.
- Run the app with FEEDBACK_TARGET=fake: open the dialog from every trigger, check the
  preview contains neither the dialog, its backdrop nor the trigger button, submit.
- Run the project's own lint, typecheck and tests.
- Report: files changed, env vars to set, and what the human still has to do —
  a Kolibri project for the reports (everyone who can see it can open every screenshot),
  a confined write token, and `npx kolibri-feedback-preflight --cleanup` with the env
  vars set (exit code 0 means ready). Say plainly what you did not verify.

Do not: call Kolibri from the browser; generate non-UUID report ids; lower the 2560 px
capture limit; keep screenshots after successful delivery; add identity fields to the
form; put the feedback route behind a server action.
````
