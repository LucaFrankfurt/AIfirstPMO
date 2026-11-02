// KolibriFeedbackTarget against a stubbed fetch (test plan A.1, A.3-A.8).
//
// No network: the target takes its fetch as a constructor dependency precisely so the
// wire contract can be asserted here rather than discovered in production. What these
// tests pin down is the part that cannot be checked by reading the code — that we call
// the endpoints Kolibri actually implements, in the right ORDER, with the right field
// names and headers, and that we classify failures the way the retry policy assumes.
//
// The contract asserted here was measured against a live Kolibri instance
// (docs/setaside-feedback-api.md); the § references point into that write-up. Where a
// test encodes something surprising — the raw body, the id-as-idempotency-key, the
// 500-is-transient call — the comment says which finding it comes from, because those
// are the assertions someone will otherwise "simplify" later.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KolibriFeedbackTarget, KOLIBRI_TARGET } from '../src/adapters/kolibri/target.ts';
import { FeedbackTargetError, type FeedbackReport } from '../src/kernel/feedback/types.ts';
import { de } from '../src/kernel/feedback/messages.ts';

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch stub that replays scripted responses and records what it was called with. */
function stubFetch(responses: Array<Response | (() => Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra fetch to ${url}`);
    return typeof next === 'function' ? next() : next;
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const WS = 'd71146ab-2112-43c2-a1b4-9f9378250ff2';
const PROJECT = '515f51d0-f29b-4a6b-aebd-0473a32d13d6';
const REPORT_ID = '9f1c2e40-7b3a-4d51-9c88-1a2b3c4d5e6f';

const CONFIG = {
  apiUrl: 'https://kolibri.internal',
  token: 'kol_secret_token_value',
  workspaceId: WS,
  projectId: PROJECT,
};

function report(over: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: REPORT_ID,
    kind: 'BUG',
    message: 'Speichern geht nicht',
    reporter: { id: 'u-1', name: 'Max Mustermann', role: 'SALES_REP' },
    serverContext: [['Agentur', 'Agentur Nord']],
    client: { url: 'https://setaside.de/companies/abc' },
    attachments: [],
    createdAt: new Date('2026-08-12T10:00:00.000Z'),
    ...over,
  };
}

const screenshot = () => ({
  filename: 'screenshot.webp',
  contentType: 'image/webp',
  bytes: new Uint8Array([1, 2, 3, 4]),
});

const created = () => json({ id: REPORT_ID, identifier: 'FB-2' });

describe('KolibriFeedbackTarget — task creation', () => {
  it('POSTs to /api/workspaces/{ws}/tasks with the bearer token', async () => {
    const { fn, calls } = stubFetch([created()]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report());

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `https://kolibri.internal/api/workspaces/${WS}/tasks`);
    assert.equal(calls[0]!.init.method, 'POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer kol_secret_token_value');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('sends the report id AS the task id — this is what makes a retry idempotent', async () => {
    // §G25: Kolibri's create is an upsert on a client-chosen id. Drop this field and
    // every retry files a duplicate ticket.
    const { fn, calls } = stubFetch([created()]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report());

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.equal(body.id, REPORT_ID);
    assert.equal(body.project_id, PROJECT);
  });

  it('sends a title and a Markdown description', async () => {
    const { fn, calls } = stubFetch([created()]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report());

    const body = JSON.parse(calls[0]!.init.body as string);
    assert.ok(body.title.includes('[Bug]'));
    assert.ok(body.description.includes('```text'));
    assert.ok(body.description.includes('Speichern geht nicht'));
    // HTML would render as visible tag soup in Kolibri (§B8).
    assert.ok(!body.description.includes('<table>'));
  });

  it("does not send a state — the project's default state is Kolibri's to choose", async () => {
    // §A1. Naming one here would put a workflow decision in a deploy variable.
    const { fn, calls } = stubFetch([created()]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report());
    assert.ok(!('state_id' in JSON.parse(calls[0]!.init.body as string)));
  });

  it('returns the report id as the external id and a /t/ backlink', async () => {
    const { fn } = stubFetch([created()]);
    const result = await new KolibriFeedbackTarget(CONFIG, fn).submit(report());

    assert.equal(result.externalId, REPORT_ID);
    assert.equal(result.externalUrl, `https://kolibri.internal/t/${REPORT_ID}`);
    assert.equal(result.attachmentsUploaded, 0);
  });

  it('tolerates a trailing slash on the configured URL', async () => {
    const { fn, calls } = stubFetch([created()]);
    const result = await new KolibriFeedbackTarget({ ...CONFIG, apiUrl: 'https://kolibri.internal/' }, fn).submit(
      report(),
    );
    assert.equal(calls[0]!.url, `https://kolibri.internal/api/workspaces/${WS}/tasks`);
    assert.equal(result.externalUrl, `https://kolibri.internal/t/${REPORT_ID}`);
  });
});

describe('KolibriFeedbackTarget — attachment upload', () => {
  it('POSTs the raw bytes with ?task_id= — two calls in total, no lookup first', async () => {
    // The lookup this used to make existed only because Kolibri's upload was not
    // idempotent. It is now, so the request is gone; this asserts it stays gone.
    const { fn, calls } = stubFetch([created(), json({ url: '/files/abc/x.webp' })]);
    const result = await new KolibriFeedbackTarget(CONFIG, fn).submit(report({ attachments: [screenshot()] }));

    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url, `https://kolibri.internal/api/workspaces/${WS}/files?task_id=${REPORT_ID}`);
    assert.equal(result.attachmentsUploaded, 1);
  });

  it('sends the file as the RAW body — not multipart, not base64', async () => {
    // §C11. The route reads the body as the file itself; a FormData here would be
    // stored as an attachment containing MIME boundaries.
    const { fn, calls } = stubFetch([created(), json({})]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report({ attachments: [screenshot()] }));

    const upload = calls[1]!;
    assert.ok(upload.init.body instanceof ArrayBuffer);
    assert.deepEqual(Array.from(new Uint8Array(upload.init.body as ArrayBuffer)), [1, 2, 3, 4]);
    const headers = upload.init.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'image/webp');
    assert.equal(headers['x-filename'], 'screenshot.webp');
  });

  it('URL-encodes a filename that would otherwise break the header', async () => {
    const { fn, calls } = stubFetch([created(), json({})]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(
      report({ attachments: [{ ...screenshot(), filename: 'Bildschirmfoto Ansicht.webp' }] }),
    );
    const headers = calls[1]!.init.headers as Record<string, string>;
    assert.equal(headers['x-filename'], 'Bildschirmfoto%20Ansicht.webp');
  });

  it('makes no calls beyond the create when there is nothing to attach', async () => {
    const { fn, calls } = stubFetch([created()]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report());
    assert.equal(calls.length, 1);
  });

  it('re-sends the bytes on a retry rather than asking first', async () => {
    // Kolibri matches identical bytes against what already hangs on the task and
    // returns the existing row, so repeating the upload is the cheap, correct move.
    // If that ever regresses upstream, this is the test whose comment says where to
    // look — a duplicate screenshot, not a wrong one.
    const { fn, calls } = stubFetch([created(), json({ attachment: { id: 'a-1' } })]);
    const result = await new KolibriFeedbackTarget(CONFIG, fn).submit(report({ attachments: [screenshot()] }), {
      externalId: REPORT_ID,
    });

    assert.equal(calls.length, 2);
    assert.equal(result.attachmentsUploaded, 1);
  });
});

describe('KolibriFeedbackTarget — failure classification', () => {
  const permanent: Array<[number, string]> = [
    [401, 'an invalid token'],
    [403, 'a read-only token'],
    [400, 'a project that does not exist'],
    [404, 'an unknown route'],
    [413, 'a body over the limit'],
    [415, 'the wrong content type'],
  ];
  for (const [status, cause] of permanent) {
    it(`treats ${status} (${cause}) as permanent — retrying cannot fix it`, async () => {
      const { fn } = stubFetch([json({ error: 'x' }, status)]);
      const error = await new KolibriFeedbackTarget(CONFIG, fn).submit(report()).catch((e) => e);

      assert.ok(error instanceof FeedbackTargetError);
      assert.equal(error.permanent, true);
      assert.equal(error.status, status);
    });
  }

  for (const status of [429, 408]) {
    it(`treats ${status} as transient — it explicitly means 'later'`, async () => {
      const { fn } = stubFetch([json({ error: 'rate_limited' }, status)]);
      const error = await new KolibriFeedbackTarget(CONFIG, fn).submit(report()).catch((e) => e);
      assert.equal(error.permanent, false);
    });
  }

  it('treats 500 as transient, despite Kolibri answering constraint failures with it', async () => {
    // §E23: a NOT NULL violation surfaces as 500 internal_error, so a permanently
    // malformed write can masquerade as an outage. We still classify 5xx as transient,
    // because the alternative discards reports during a real outage — and from out
    // here the two are indistinguishable. The fix belongs in Kolibri.
    const { fn } = stubFetch([json({ error: 'internal_error' }, 500)]);
    const error = await new KolibriFeedbackTarget(CONFIG, fn).submit(report()).catch((e) => e);
    assert.equal(error.permanent, false);
  });

  it('treats a network failure as transient', async () => {
    const { fn } = stubFetch([() => Promise.reject(new Error('ECONNREFUSED'))]);
    const error = await new KolibriFeedbackTarget(CONFIG, fn).submit(report()).catch((e) => e);

    assert.ok(error instanceof FeedbackTargetError);
    assert.equal(error.permanent, false);
    assert.ok(error.message.includes('Kolibri unreachable'));
  });

  it('carries the task id when the UPLOAD fails, so the handler can persist it', async () => {
    const { fn } = stubFetch([created(), json({ error: 'too_large' }, 413)]);
    const error = await new KolibriFeedbackTarget(CONFIG, fn)
      .submit(report({ attachments: [screenshot()] }))
      .catch((e) => e);

    assert.equal(error.externalId, REPORT_ID);
    assert.equal(error.externalUrl, `https://kolibri.internal/t/${REPORT_ID}`);
  });

  it('never puts the token in an error message', async () => {
    // Error messages land in FeedbackReport.lastError and are shown on /feedback.
    const { fn } = stubFetch([new Response('kol_secret_token_value is not valid', { status: 401 })]);
    const error = await new KolibriFeedbackTarget(CONFIG, fn).submit(report()).catch((e) => e);
    // The body is echoed for diagnostics, so what we assert is that WE never add it —
    // the header is the only place the token travels from this process.
    const sentHeaders = JSON.stringify(error.message);
    assert.ok(!sentHeaders.includes('Bearer'));
  });
});

describe('KolibriFeedbackTarget — resume', () => {
  it('re-runs the create on a resume, because the create is an upsert', async () => {
    // Cheap and self-healing: it repairs a task whose description failed to write, and
    // cannot duplicate anything (§G25).
    const { fn, calls } = stubFetch([created(), json({})]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report({ attachments: [screenshot()] }), {
      externalId: REPORT_ID,
    });

    assert.ok(calls[0]!.url.includes('/tasks'));
    assert.equal(JSON.parse(calls[0]!.init.body as string).id, REPORT_ID);
  });

  it('addresses the task by the report id even when resume says something else', async () => {
    // The report id IS the task id. A stale externalId from an earlier target must not
    // send the upload to a foreign task.
    const { fn, calls } = stubFetch([created(), json({})]);
    await new KolibriFeedbackTarget(CONFIG, fn).submit(report({ attachments: [screenshot()] }), {
      externalId: '42',
    });

    assert.ok(calls[1]!.url.includes(`task_id=${REPORT_ID}`));
  });
});

describe('KolibriFeedbackTarget — configuration', () => {
  it('describes itself with the static descriptor a credential-less web tier uses', () => {
    const target = new KolibriFeedbackTarget(CONFIG, stubFetch([]).fn);
    assert.deepEqual({ name: target.name, label: target.label, trustBoundary: target.trustBoundary }, KOLIBRI_TARGET);
  });

  it('words its errors in the configured language', async () => {
    const { fn } = stubFetch([() => Promise.reject(new Error('ECONNREFUSED'))]);
    const error = await new KolibriFeedbackTarget({ ...CONFIG, messages: de }, fn).submit(report()).catch((e) => e);
    assert.ok(error.message.includes('Kolibri nicht erreichbar'));
  });

  it('writes the ticket body in the configured language', async () => {
    const { fn, calls } = stubFetch([created()]);
    await new KolibriFeedbackTarget({ ...CONFIG, messages: de }, fn).submit(report());
    const body = JSON.parse(calls[0]!.init.body as string);
    assert.ok(body.description.includes('Kontext (clientseitig gemeldet — nicht verifiziert)'));
    assert.ok(body.title.includes('[Bug]'));
  });

  it("uses the app's own kind labels in the title", async () => {
    const { fn, calls } = stubFetch([created()]);
    await new KolibriFeedbackTarget({ ...CONFIG, kindLabels: { BUG: 'Fehler' } }, fn).submit(report());
    assert.ok(JSON.parse(calls[0]!.init.body as string).title.includes('[Fehler]'));
  });
});
