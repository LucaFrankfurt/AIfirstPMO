// Kolibri preflight — the gate before FEEDBACK_TARGET=kolibri goes live.
//
// WHY THIS EXISTS, and why no unit test replaces it. Two properties of the LIVE
// instance decide whether delivery works, and neither is knowable from the code:
//
//   1. Does the token carry the `write` scope over BOTH routes? Kolibri refuses a
//      read-only token on every write, the file upload included — and the upload is a
//      hand-written route, not a CRUD one. Stubbed-fetch tests cannot answer it, and
//      assuming the answer is how you find out in production that every report arrives
//      without its screenshot.
//   2. WHO can see the screenshots? The feedback project's members — but only on a
//      Kolibri that scopes attachments by the project of the task they hang off. Older
//      instances checked workspace membership alone, so a private project protected the
//      task text and not its screenshot. Step 2 prints the member list for a human to
//      confirm, and that is not a formality: it is the one check a code review cannot
//      perform on anyone's behalf.
//
// Steps 3 and 4 deliberately run through the REAL KolibriFeedbackTarget rather than
// reimplementing the calls, so what is verified is the production delivery path.
//
// Usage:
//   FEEDBACK_TARGET=kolibri \
//   KOLIBRI_API_URL=https://kolibri.example.com \
//   KOLIBRI_TOKEN=kol_… \
//   KOLIBRI_WORKSPACE_ID=<uuid> \
//   KOLIBRI_PROJECT_ID=<uuid> \
//   npx kolibri-feedback-preflight [--cleanup] [--image <path>]
//
// Flags:
//   --cleanup        delete the test task when finished (default: leave it for review)
//   --image <path>   use a different attachment instead of the bundled test image
//
// The token is a secret: pass it as an environment variable, never as an argument
// (arguments show up in shell history and in `ps`).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FeedbackTargetError, type FeedbackReport } from '../../kernel/feedback/types.ts';
import { KolibriFeedbackTarget } from './target.ts';
import { kolibriConfigFromEnv, type Env } from './env.ts';

const PACKAGE_NAME = '@kolibri-day/feedback';

/**
 * The package root, found by walking up from the running script — the same answer
 * whether it runs from dist/cjs (the installed bin) or from src (a checkout), and
 * without `__dirname`, which an ES-module build does not have.
 *
 * The script path is resolved through symlinks first: npm installs a bin as a link in
 * node_modules/.bin, and walking up from the link would search the wrong tree.
 */
function packageRoot(): string | null {
  let dir: string;
  try {
    dir = dirname(realpathSync(process.argv[1] ?? '.'));
  } catch {
    return null;
  }
  for (let i = 0; i < 8; i++) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name;
      if (name === PACKAGE_NAME) return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

type Outcome = 'pass' | 'fail' | 'skip';

const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const warn = (s: string) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);
const step = (n: number, s: string) => console.log(`\n[${n}/6] ${s}`);

/**
 * Kolibri returns lists in one of two shapes depending on the route (`{tasks: [...]}`
 * per openapi.json, a bare array in practice). Reading both is three lines and removes
 * a way for this script to report "nothing there" at a full instance.
 */
function rows<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const wrapped = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

interface Session {
  user?: { id?: string; name?: string; email?: string };
  workspaces?: Array<{ id: string; name: string; slug?: string; role?: string }>;
}

interface DispatchOutcome {
  taskId: string | null;
  uploaded: boolean;
  webUrl: string | null;
}

class Preflight {
  private readonly env: Env;
  private readonly cleanup: boolean;
  private readonly imagePath: string;
  private readonly results: Record<string, Outcome> = {};
  private session: Session = {};

  constructor(env: Env, args: readonly string[]) {
    this.env = env;
    this.cleanup = args.includes('--cleanup');
    const imageAt = args.indexOf('--image');
    const given = imageAt >= 0 ? args[imageAt + 1] : undefined;
    // A realistic ~380 KB WebP — the upper end of what the browser capture produces.
    // Shipped rather than generated, so no image encoder is needed here.
    const root = packageRoot();
    this.imagePath = given ?? (root ? join(root, 'fixtures', 'preflight-screenshot.webp') : '');
  }

  private get base(): string {
    return (this.env.KOLIBRI_API_URL ?? '').replace(/\/+$/, '');
  }

  private get ws(): string {
    return this.env.KOLIBRI_WORKSPACE_ID ?? '';
  }

  /** Authorized GET against the API. Returns the raw Response — callers read the status. */
  private get(path: string): Promise<Response> {
    return fetch(path.startsWith('http') ? path : `${this.base}${path}`, {
      headers: { Authorization: `Bearer ${this.env.KOLIBRI_TOKEN ?? ''}` },
      signal: AbortSignal.timeout(20_000),
    });
  }

  /**
   * Does this rejection look like it came from something OTHER than Kolibri?
   *
   * Kolibri answers every error with a JSON envelope ({"error": …, "message": …}). A
   * corporate proxy, a VPN gateway or a WAF in front of the instance answers with HTML,
   * plain text, or nothing — typically 403. Without this check the script would blame
   * the token for what is really an unreachable host, and send someone off re-minting
   * tokens for no reason.
   */
  private async gatewayHint(res: Response): Promise<boolean> {
    const body = await res.text().catch(() => '');
    const contentType = res.headers.get('content-type') ?? '';
    const looksLikeKolibri = contentType.includes('json') || body.trimStart().startsWith('{');
    if (looksLikeKolibri) return false;

    warn('This answer probably did NOT come from Kolibri.');
    info(`Content-Type: ${contentType || '(none)'}; body: ${body.slice(0, 120).trim() || '(empty)'}`);
    info('Kolibri answers every error with JSON ({"error": …, "message": …}).');
    info('A proxy, VPN gateway or WAF in front of it does not.');
    info('→ Check that the host is reachable from here (VPN, network) before changing the token:');
    // "$KOLIBRI_TOKEN" is printed as a variable REFERENCE, so the line is copy-pasteable
    // without the secret itself ever appearing on screen.
    info(`     curl -i -H "Authorization: Bearer $KOLIBRI_TOKEN" ${this.base}/api/session`);
    return true;
  }

  private async stepSession(): Promise<boolean> {
    step(1, 'Token and account');

    const res = await this.get('/api/session').catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    if (res instanceof Error) {
      bad(`Instance unreachable: ${res.message}`);
      info(`Checked: ${this.base}`);
      info('→ Check KOLIBRI_API_URL (the origin, NOT /api) and network/VPN access.');
      this.results.auth = 'fail';
      return false;
    }

    if (res.status === 401) {
      bad('Token rejected (HTTP 401) — invalid, revoked, expired or copied wrongly');
      info('→ Create a new token in Kolibri (Settings → API & MCP).');
      this.results.auth = 'fail';
      return false;
    }
    if (res.status !== 200) {
      bad(`Unexpected status ${res.status} from GET /api/session`);
      await this.gatewayHint(res);
      this.results.auth = 'fail';
      return false;
    }

    this.session = ((await res.json().catch(() => ({}))) ?? {}) as Session;
    const user = this.session.user;
    ok(`Token is valid — account: ${user?.name ?? '(no name)'} <${user?.email ?? '?'}>`);

    // A CONFINED token reports exactly one workspace, because Kolibri narrows the
    // membership map behind every gate when the token carries the flag. So this count
    // is the cheapest honest test of whether confinement actually took, and it fails
    // loudly rather than leaving an over-broad credential in place.
    const all = this.session.workspaces ?? [];
    const only = all.length === 1 ? all[0] : undefined;
    if (only && only.id === this.ws) {
      ok(`Token is confined to one workspace: ${only.name}`);
    } else if (all.length > 1) {
      bad(`The token sees ${all.length} workspaces — it is NOT confined.`);
      for (const w of all) info(`   ${w.name}${w.slug ? ` (${w.slug})` : ''} — ${w.role ?? '?'}`);
      info('');
      info('Without `confined` a token carries the full reach of its account. When the');
      info('feedback project lives in a shared workspace, a dedicated account is not enough');
      info('on its own — the restriction has to be on the token.');
      info('→ Mint it again (README, "Kolibri setup"):');
      info(`     POST /api/tokens {"workspaceId":"${this.ws}","confined":true,"scopes":"write"}`);
      this.results.auth = 'fail';
      return false;
    } else {
      warn('The token sees no workspace, or a different one than configured.');
      for (const w of all) info(`   ${w.id} → ${w.name}`);
      info('→ Check KOLIBRI_WORKSPACE_ID and what the token is bound to.');
    }

    this.results.auth = 'pass';
    return true;
  }

  private async stepWorkspaceAndProject(): Promise<boolean> {
    step(2, 'Workspace, project and audience');

    const workspace = (this.session.workspaces ?? []).find((w) => w.id === this.ws);
    if (!workspace) {
      bad(`KOLIBRI_WORKSPACE_ID (${this.ws}) is not one of this account's workspaces`);
      info('Visible workspaces (id → name):');
      for (const w of this.session.workspaces ?? []) info(`   ${w.id} → ${w.name}`);
      info('→ Set KOLIBRI_WORKSPACE_ID to the UUID of the feedback workspace.');
      this.results.project = 'fail';
      return false;
    }
    ok(`Workspace: ${workspace.name} (role: ${workspace.role ?? '?'})`);

    const projRes = await this.get(`/api/workspaces/${this.ws}/projects`);
    if (projRes.status !== 200) {
      bad(`Could not list projects (HTTP ${projRes.status})`);
      await this.gatewayHint(projRes);
      this.results.project = 'fail';
      return false;
    }

    const projects = rows<{ id: string; key?: string; name?: string; visibility?: string }>(
      await projRes.json().catch(() => []),
      'projects',
    );
    const project = projects.find((p) => p.id === this.env.KOLIBRI_PROJECT_ID);
    if (!project) {
      bad(`KOLIBRI_PROJECT_ID (${this.env.KOLIBRI_PROJECT_ID ?? ''}) is not visible to this account`);
      // Two very different causes, one symptom — and the second is the likelier one for
      // a fresh setup, so it is named first. A private project simply does not appear in
      // this list for a non-member, which reads exactly like a wrong id.
      info('Two possible causes:');
      info('  1. The account is NOT a member of the project. A private project does not');
      info('     appear for non-members at all. Writing would still work — task create and');
      info('     upload do not ask about the project — but reading back does not, and that is');
      info('     what step 5 does. → Add the account to the project (README, "Kolibri setup").');
      info('  2. The id is wrong. Projects visible in this workspace:');
      for (const p of projects) info(`     ${p.id} → ${p.key ?? '—'} → ${p.name ?? '(no name)'}`);
      info('     → Set KOLIBRI_PROJECT_ID to the UUID, NOT the key.');
      this.results.project = 'fail';
      return false;
    }

    // The point of this step: a human confirms the NAME, because a wrong-but-valid id
    // would silently file screenshots into the wrong board.
    const isPrivate = project.visibility === 'private';
    console.log(
      `\n      Project: \x1b[1m${project.name ?? '(no name)'}\x1b[0m (${project.key ?? '—'}) — ` +
        `${isPrivate ? 'private' : 'public within the workspace'}\n`,
    );
    info('↑ PLEASE CHECK: is this the project feedback should land in?');

    // Who can open a screenshot is READ here, not asked about: whoever can see the
    // project, and the project itself says which set that is.
    const memRes = await this.get(`/api/workspaces/${this.ws}/members`);
    const workspaceMembers =
      memRes.status === 200
        ? rows<{ id?: string; name?: string; email?: string; role?: string }>(
            await memRes.json().catch(() => []),
            'members',
          )
        : null;

    if (!workspaceMembers) {
      warn(`Could not list members (HTTP ${memRes.status}) — please check in the web app.`);
      info('Whoever can see the project can open every screenshot in it.');
      this.results.project = 'pass';
      return true;
    }

    console.log('');
    if (!isPrivate) {
      warn(`The project is PUBLIC — all ${workspaceMembers.length} workspace members can open every screenshot:`);
      for (const m of workspaceMembers) info(`   ${m.name ?? '?'} <${m.email ?? '?'}> — ${m.role ?? '?'}`);
      info('');
      info('That is fine if the workspace is exactly that audience anyway — but then the');
      info('WORKSPACE membership is the privacy boundary: inviting someone to it also hands');
      info('them every feedback screenshot.');
    } else {
      const pmRes = await this.get(
        `/api/workspaces/${this.ws}/project-members?project_id=${encodeURIComponent(project.id)}`,
      );
      const projectMembers =
        pmRes.status === 200
          ? rows<{ user_id?: string; role?: string }>(await pmRes.json().catch(() => []), 'project-members')
          : [];
      const byId = new Map(workspaceMembers.map((m) => [m.id, m]));

      warn(`The project is private — ${projectMembers.length} person(s) can open the screenshots:`);
      for (const pm of projectMembers) {
        const who = byId.get(pm.user_id);
        info(`   ${who?.name ?? pm.user_id ?? '?'} <${who?.email ?? '?'}> — ${pm.role ?? '?'}`);
      }
      if (projectMembers.length === 0) {
        info('   (none — Kolibri has no screen for this, see README, "Kolibri setup")');
      }
    }
    info('');
    info('↑ PLEASE CHECK: may every one of these people see whatever a screenshot of the app can show?');

    this.results.project = 'pass';
    return true;
  }

  private async stepCreateAndUpload(target: KolibriFeedbackTarget, reportId: string): Promise<DispatchOutcome> {
    const image = readFileSync(this.imagePath);
    const report: FeedbackReport = {
      // A real UUID, not a fixed string: it becomes the TASK id (§G25), so a constant
      // would make every preflight run upsert into the same task and pile attachments
      // onto it — which is exactly the thing step 5 is trying to count.
      id: reportId,
      kind: 'OTHER',
      message:
        `Kolibri preflight (${PACKAGE_NAME}).\n\n` +
        'Automatically created test entry: checks that task creation AND file upload work ' +
        'with the configured API token.\n\n' +
        'Contains NO real customer data. Safe to delete.',
      reporter: { id: 'preflight', name: 'Feedback preflight' },
      client: { url: 'https://preflight.invalid/', userAgent: 'kolibri-feedback-preflight' },
      attachments: [{ filename: 'preflight-screenshot.webp', contentType: 'image/webp', bytes: new Uint8Array(image) }],
      createdAt: new Date(),
    };

    step(3, 'Task creation');
    info(
      `Attachment: ${this.imagePath.split('/').pop() ?? ''} (${Math.round(image.byteLength / 1024)} KB, image/webp)`,
    );

    try {
      const result = await target.submit(report);

      ok(`Task ${result.externalId} created`);
      if (result.externalUrl) info(`→ ${result.externalUrl}`);
      this.results.create = 'pass';

      step(4, 'File upload (the actual open question)');
      ok(`${result.attachmentsUploaded} file(s) uploaded — the token covers the upload route`);
      this.results.upload = 'pass';

      return { taskId: result.externalId, uploaded: true, webUrl: result.externalUrl };
    } catch (e) {
      const err = e instanceof FeedbackTargetError ? e : null;
      const message = e instanceof Error ? e.message : String(e);

      // externalId set ⇒ the task WAS created and the upload is what failed. That is the
      // single most informative outcome this script can produce, and precisely the
      // token-scope question it exists to answer.
      if (err?.externalId) {
        ok(`Task ${err.externalId} created`);
        if (err.externalUrl) info(`→ ${err.externalUrl}`);
        this.results.create = 'pass';

        step(4, 'File upload (the actual open question)');
        bad(`Upload FAILED (HTTP ${err.status ?? '?'})`);
        info(message.slice(0, 300));

        if (err.status === 403) {
          console.log('');
          warn('Most likely cause: the token is READ-ONLY.');
          info('Kolibri answers every write from such a token with 403 "Token is read-only" —');
          info('the upload just like task creation. That step 3 passed speaks against it,');
          info('which leaves the workspace role:');
          info('  • a guest in the workspace may not upload (role ≥ member is required).');
          info('→ Mint a token with scope `write` (Settings → API & MCP) and give the account');
          info('  at least the `member` role in the feedback workspace.');
        }
        if (err.status === 413) {
          console.log('');
          warn('The file is larger than the instance upload limit.');
          info('Read the limit (no authentication needed):');
          info(`     curl -s ${this.base}/api/config`);
          info('→ Raise KOLIBRI_MAX_UPLOAD_MB, or check a reverse proxy in front of it.');
        }
        this.results.upload = 'fail';
        return { taskId: err.externalId, uploaded: false, webUrl: err.externalUrl ?? null };
      }

      bad(`Task creation FAILED (HTTP ${err?.status ?? '?'})`);
      info(message.slice(0, 300));
      if (err?.status === 403) {
        info('The token authenticates but may not write.');
        info('→ Mint a token with scope `write` (Settings → API & MCP).');
      }
      if (err?.status === 400) {
        info('Kolibri refused the body — almost always a wrong KOLIBRI_PROJECT_ID.');
        info('→ It must be the project UUID, not the key. Step 2 lists both.');
      }
      this.results.create = 'fail';
      this.results.upload = 'skip';
      return { taskId: null, uploaded: false, webUrl: null };
    }
  }

  private async stepRetrieve(taskId: string, expectedBytes: number): Promise<void> {
    step(5, 'Attachment stored and retrievable?');

    // The LIST endpoint is the load-bearing check: it reports the STORED size, which
    // confirms Kolibri actually persisted the bytes rather than accepting and dropping
    // them.
    const listRes = await this.get(`/api/workspaces/${this.ws}/attachments?task_id=${encodeURIComponent(taskId)}`);
    if (listRes.status !== 200) {
      warn(`Could not list attachments (HTTP ${listRes.status})`);
      info('Not critical: the app only UPLOADS attachments, it never downloads them.');
      info('→ Open the task in the web app instead and check the attachment there.');
      this.results.retrieve = 'skip';
      return;
    }

    const list = rows<{ id?: string; name?: string; size?: number; mime?: string; url?: string }>(
      await listRes.json().catch(() => []),
      'attachments',
    );
    const attachment = list[0];

    if (!attachment) {
      bad('The API says the task has NO attachments — the upload was accepted but nothing was stored');
      this.results.retrieve = 'fail';
      return;
    }
    if (list.length > 1) {
      // Not a failure, but it means Kolibri's upload deduplication did not do its job.
      warn(`${list.length} attachments on a task with one screenshot — please report this.`);
    }

    const storedSize = attachment.size ?? 0;
    ok(`Attachment stored: ${attachment.name ?? '?'} (${Math.round(storedSize / 1024)} KB, ${attachment.mime ?? '?'})`);

    // Tolerance rather than exact equality. The failure mode worth catching is
    // TRUNCATION — a size cap or a reverse-proxy body limit silently storing a partial
    // file — which shows up as a dramatic shortfall, not a few bytes.
    const drift = Math.abs(storedSize - expectedBytes);
    if (drift === 0) {
      ok(`Size matches the upload exactly (${expectedBytes} bytes) — nothing truncated`);
      this.results.retrieve = 'pass';
    } else if (drift <= expectedBytes * 0.01) {
      ok(`Size practically identical (${storedSize} instead of ${expectedBytes} bytes) — nothing truncated`);
      this.results.retrieve = 'pass';
    } else {
      bad(`The file was apparently TRUNCATED: uploaded ${expectedBytes} bytes, stored ${storedSize}`);
      info(`→ Check for a size limit: curl -s ${this.base}/api/config (maxUploadBytes),`);
      info('   or a reverse proxy in front of it. Screenshots are typically 150–400 KB.');
      this.results.retrieve = 'fail';
      return;
    }

    // Bonus: fetch it back. A stored-but-unreadable attachment would mean whoever triages
    // the ticket sees a broken image.
    if (!attachment.url) {
      warn('The attachment row carries no URL — download skipped.');
      return;
    }
    const dl = await this.get(attachment.url);
    if (dl.status === 200) {
      const bytes = new Uint8Array(await dl.arrayBuffer());
      if (Math.abs(bytes.byteLength - expectedBytes) <= expectedBytes * 0.01) {
        ok(`Download returns the whole file (${bytes.byteLength} bytes, ${dl.headers.get('content-type') ?? '?'})`);
      } else {
        warn(`Download returns only ${bytes.byteLength} bytes (uploaded: ${expectedBytes})`);
      }
    } else {
      warn(`Attachment not retrievable (HTTP ${dl.status}) — the task will show a broken image.`);
      info('Irrelevant for delivery (the app only uploads), but not for triage.');
    }
  }

  private async stepCleanup(taskId: string, webUrl: string | null): Promise<void> {
    step(6, this.cleanup ? 'Cleanup' : 'Cleanup (skipped)');

    if (!this.cleanup) {
      info('The test task stays, so it can be reviewed.');
      if (webUrl) info(`→ ${webUrl}`);
      info('Pass --cleanup to delete it automatically.');
      this.results.cleanup = 'skip';
      return;
    }

    const res = await fetch(`${this.base}/api/tasks/${taskId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.env.KOLIBRI_TOKEN ?? ''}` },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.ok) {
      ok(`Test task ${taskId} deleted`);
      // Honest about what deletion does and does not do: Kolibri's storage is
      // content-addressed and shared, so removing the task unlinks the attachment but
      // leaves the blob. Harmless for a test image; worth knowing before someone assumes
      // --cleanup erases an accidentally-uploaded screenshot.
      info('Note: the blob stays in the content-addressed store; only the link is removed.');
      this.results.cleanup = 'pass';
    } else {
      warn(`Test task ${taskId} could not be deleted (HTTP ${res.status}) — please delete it by hand`);
      if (webUrl) info(`→ ${webUrl}`);
      this.results.cleanup = 'fail';
    }
  }

  /** The summary, and the exit code: 0 only when creation AND upload passed. */
  private finish(): number {
    const label: Record<string, string> = {
      auth: '1. Token valid',
      project: '2. Workspace + project confirmed',
      create: '3. Task creation',
      upload: '4. File upload',
      retrieve: '5. Attachment stored',
      cleanup: '6. Cleaned up',
    };
    const mark = { pass: '\x1b[32m✓\x1b[0m', fail: '\x1b[31m✗\x1b[0m', skip: '\x1b[33m–\x1b[0m' };

    console.log('\n' + '─'.repeat(60));
    console.log('Result');
    for (const key of Object.keys(label)) {
      const r = this.results[key];
      console.log(`  ${r ? mark[r] : '\x1b[90m·\x1b[0m'} ${label[key]}`);
    }

    // The verdict is deliberately narrow: only steps 3 and 4 decide whether delivery
    // works. Step 5's retrieval and step 6's cleanup are diagnostics.
    const goLive = this.results.create === 'pass' && this.results.upload === 'pass';
    console.log('');
    if (goLive) {
      console.log('\x1b[32mReady for production\x1b[0m — FEEDBACK_TARGET=kolibri can be set');
      console.log('ONCE the project and the audience from step 2 are confirmed.');
    } else {
      console.log('\x1b[31mDo NOT go live yet\x1b[0m — see the failed steps above.');
    }
    console.log('─'.repeat(60));
    return goLive ? 0 : 1;
  }

  async run(): Promise<number> {
    const choice = (this.env.FEEDBACK_TARGET ?? '').trim().toLowerCase();
    if (choice !== 'kolibri') {
      console.error(`\n\x1b[31mFEEDBACK_TARGET is "${choice}", not "kolibri" — nothing to check.\x1b[0m`);
      return 1;
    }
    const read = kolibriConfigFromEnv(this.env);
    if (!read.ok) {
      console.error(`\n\x1b[31mConfiguration incomplete:\x1b[0m ${read.reason}`);
      return 1;
    }
    if (!this.imagePath || !existsSync(this.imagePath)) {
      console.error(
        `\n\x1b[31mTest image not found\x1b[0m${this.imagePath ? ` at ${this.imagePath}` : ''} — pass one with --image <path>.`,
      );
      return 1;
    }

    console.log('Kolibri preflight');
    console.log(`  Instance:  ${this.base}`);
    console.log(`  Workspace: ${this.ws}`);
    console.log(`  Project:   ${this.env.KOLIBRI_PROJECT_ID ?? ''}`);

    if (!(await this.stepSession())) return this.finish();
    if (!(await this.stepWorkspaceAndProject())) return this.finish();

    const outcome = await this.stepCreateAndUpload(new KolibriFeedbackTarget(read.config), randomUUID());
    if (!outcome.taskId) return this.finish();

    if (outcome.uploaded) {
      await this.stepRetrieve(outcome.taskId, readFileSync(this.imagePath).byteLength);
    } else {
      step(5, 'Attachment stored and retrievable? (skipped)');
      info('No attachment was stored — see step 4.');
      this.results.retrieve = 'skip';
    }

    await this.stepCleanup(outcome.taskId, outcome.webUrl);
    return this.finish();
  }
}

/**
 * Run the six checks against the instance the environment names, printing as it goes.
 * Resolves with the exit code: 0 when task creation and upload both passed.
 */
export function runPreflight(env: Env, args: readonly string[]): Promise<number> {
  return new Preflight(env, args).run();
}
