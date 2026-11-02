// resolveFeedbackTarget (test plan A.9).
//
// The behaviour under test is mostly about what must NOT happen: a missing variable
// must not throw at worker boot (that would take crawl/discovery/commission down over
// a feedback setting), and an unconfigured PRODUCTION deployment must not silently
// swallow reports into a fake.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matches } from './helpers.ts';
import { resolveFeedbackTarget, describeFeedbackTarget } from '../src/wiring.ts';
import { FakeFeedbackTarget, UnconfiguredFeedbackTarget } from '../src/kernel/feedback/fake-target.ts';
import { KolibriFeedbackTarget } from '../src/adapters/kolibri/target.ts';
import { de } from '../src/kernel/feedback/messages.ts';

const KOLIBRI_ENV = {
  FEEDBACK_TARGET: 'kolibri',
  KOLIBRI_API_URL: 'https://kolibri.internal',
  KOLIBRI_TOKEN: 'kol_abc',
  KOLIBRI_WORKSPACE_ID: 'd71146ab-2112-43c2-a1b4-9f9378250ff2',
  KOLIBRI_PROJECT_ID: '515f51d0-f29b-4a6b-aebd-0473a32d13d6',
};

describe('resolveFeedbackTarget', () => {
  it("never throws — a misconfiguration must not take the worker's boot down", () => {
    // Every other job type (crawl, discovery, commission) shares this process.
    assert.doesNotThrow(() => resolveFeedbackTarget({ FEEDBACK_TARGET: 'nonsense' }));
    assert.doesNotThrow(() => resolveFeedbackTarget({}));
    assert.doesNotThrow(() => resolveFeedbackTarget({ FEEDBACK_TARGET: 'kolibri' }));
  });

  it('defaults to the fake in development, with no warning', () => {
    const { target, warning } = resolveFeedbackTarget({});
    assert.ok(target instanceof FakeFeedbackTarget);
    assert.equal(warning, null);
  });

  it('does NOT fall back to the fake when unset in production', async () => {
    // The one outcome worse than a loud failure: reports that reach nobody while
    // everyone believes the feature works.
    const { target, warning } = resolveFeedbackTarget({ NODE_ENV: 'production' });
    assert.ok(target instanceof UnconfiguredFeedbackTarget);
    assert.ok(warning?.includes('FEEDBACK_TARGET'));
    await assert.rejects(target.submit({} as never), (error) => matches(error, { permanent: true }));
  });

  it('warns when the fake is explicitly selected in production', () => {
    const { target, warning } = resolveFeedbackTarget({
      NODE_ENV: 'production',
      FEEDBACK_TARGET: 'fake',
    });
    // Deliberate, so it is allowed — but it should never be silent.
    assert.ok(target instanceof FakeFeedbackTarget);
    assert.ok(warning?.includes('fake'));
  });

  it('builds a Kolibri target when fully configured', () => {
    const { target, warning } = resolveFeedbackTarget(KOLIBRI_ENV);
    assert.ok(target instanceof KolibriFeedbackTarget);
    assert.equal(target.name, 'kolibri');
    assert.equal(target.trustBoundary, 'self_hosted');
    assert.equal(warning, null);
  });

  for (const missing of ['KOLIBRI_API_URL', 'KOLIBRI_TOKEN', 'KOLIBRI_WORKSPACE_ID', 'KOLIBRI_PROJECT_ID']) {
    it(`names ${missing} when it is the missing variable`, async () => {
      const env = { ...KOLIBRI_ENV, [missing]: '' };
      const { target, warning } = resolveFeedbackTarget(env);
      assert.ok(target instanceof UnconfiguredFeedbackTarget);
      assert.ok(warning?.includes(missing));
      // The same message reaches the operator per report, as its recorded last error.
      await assert.rejects(target.submit({} as never), (error: Error) => error.message.includes(missing));
    });
  }

  it('rejects a workspace slug up front instead of turning it into a 403 per report', () => {
    // Kolibri addresses workspaces by UUID only; "kolibri" is what someone reads off
    // the URL bar, and it fails on every single report until someone looks.
    const { target, warning } = resolveFeedbackTarget({ ...KOLIBRI_ENV, KOLIBRI_WORKSPACE_ID: 'feedback' });
    assert.ok(target instanceof UnconfiguredFeedbackTarget);
    assert.ok(warning?.includes('KOLIBRI_WORKSPACE_ID'));
  });

  it('rejects a project KEY up front instead of turning it into a 400 per report', () => {
    // The likeliest wrong value by far: "FB" is what the board shows and what people
    // type into a task reference, and it is not what the API accepts.
    const { target, warning } = resolveFeedbackTarget({ ...KOLIBRI_ENV, KOLIBRI_PROJECT_ID: 'FB' });
    assert.ok(target instanceof UnconfiguredFeedbackTarget);
    assert.ok(warning?.includes('KOLIBRI_PROJECT_ID'));
  });

  it('names the workspace first when both ids are wrong — it decides who sees the screenshots', () => {
    const { warning } = resolveFeedbackTarget({
      ...KOLIBRI_ENV,
      KOLIBRI_WORKSPACE_ID: 'feedback',
      KOLIBRI_PROJECT_ID: 'FB',
    });
    assert.ok(warning?.includes('KOLIBRI_WORKSPACE_ID'));
  });

  it('accepts an uppercase UUID — Kolibri does', () => {
    const { target } = resolveFeedbackTarget({
      ...KOLIBRI_ENV,
      KOLIBRI_PROJECT_ID: '515F51D0-F29B-4A6B-AEBD-0473A32D13D6',
    });
    assert.ok(target instanceof KolibriFeedbackTarget);
  });

  it('fails loudly on an unknown target name rather than guessing', () => {
    const { target, warning } = resolveFeedbackTarget({ FEEDBACK_TARGET: 'jira' });
    assert.ok(target instanceof UnconfiguredFeedbackTarget);
    assert.ok(warning?.includes('jira'));
  });

  it('fails loudly on the RETIRED target name — a stale deploy env must not look configured', () => {
    // The migration's own trap: FEEDBACK_TARGET=vikunja survives in a deploy
    // environment long after the code stops knowing the word.
    const { target, warning } = resolveFeedbackTarget({ FEEDBACK_TARGET: 'vikunja' });
    assert.ok(target instanceof UnconfiguredFeedbackTarget);
    assert.ok(warning?.includes('vikunja'));
  });

  it('is case- and whitespace-insensitive about the target name', () => {
    const { target } = resolveFeedbackTarget({ ...KOLIBRI_ENV, FEEDBACK_TARGET: '  Kolibri ' });
    assert.ok(target instanceof KolibriFeedbackTarget);
  });

  it('words its warnings in the configured language', () => {
    const { warning } = resolveFeedbackTarget({ FEEDBACK_TARGET: 'kolibri' }, { messages: de });
    assert.ok(warning?.includes('folgende Variablen fehlen'));
    assert.ok(warning?.includes('KOLIBRI_TOKEN'));
  });

  it("hands the app's kind labels to the Kolibri target's ticket title", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const { target } = resolveFeedbackTarget(KOLIBRI_ENV, {
      kindLabels: { IDEE: 'Verbesserungsidee' },
      fetch: async (url, init) => {
        calls.push({ url, body: String(init?.body) });
        return new Response('{}', { status: 200 });
      },
    });
    await target.submit({
      id: '515f51d0-f29b-4a6b-aebd-0473a32d13d6',
      kind: 'IDEE',
      message: 'Filter merken',
      reporter: { id: 'u-1', name: 'Max' },
      client: {},
      attachments: [],
      createdAt: new Date('2026-08-12T10:00:00.000Z'),
    });
    assert.equal(JSON.parse(calls[0]!.body).title, '[Verbesserungsidee] Filter merken');
  });
});

describe('describeFeedbackTarget', () => {
  it('names the target in the WEB tier, which holds no credentials', () => {
    // The web service sets FEEDBACK_TARGET and nothing else (DEPLOYMENT_CHECKLIST
    // §11.2) — it never calls Kolibri. Describing the *resolved* target there produced
    // "kein Zielsystem", so the reporter's notice read "wird in eurem selbst-betriebenen
    // kein Zielsystem gespeichert": broken German, and a false claim about where
    // customer data goes. This is the regression test for that.
    const descriptor = describeFeedbackTarget({
      FEEDBACK_TARGET: 'kolibri',
      NODE_ENV: 'production',
    });

    assert.deepEqual(descriptor, { name: 'kolibri', trustBoundary: 'self_hosted', label: 'Kolibri' });
  });

  it('describes the same target whether or not the credentials are present', () => {
    // The worker has them, the web tier does not; the reporter must be told the same
    // thing either way.
    assert.deepEqual(describeFeedbackTarget(KOLIBRI_ENV), describeFeedbackTarget({ FEEDBACK_TARGET: 'kolibri' }));
  });

  it("says 'no target' only when there genuinely is none", () => {
    matches(describeFeedbackTarget({ NODE_ENV: 'production' }), {
      name: 'unconfigured',
      label: 'no target system',
    });
    // An unknown name is the same case: we cannot honestly name a destination.
    matches(describeFeedbackTarget({ FEEDBACK_TARGET: 'jira' }), {
      name: 'unconfigured',
    });
  });

  it("falls back to the fake's own description in development", () => {
    matches(describeFeedbackTarget({}), { name: 'fake' });
  });

  it('labels the placeholders in the configured language', () => {
    matches(describeFeedbackTarget({ NODE_ENV: 'production' }, { messages: de }), {
      name: 'unconfigured',
      label: 'kein Zielsystem',
    });
    // A product name is not translated.
    assert.equal(describeFeedbackTarget({ FEEDBACK_TARGET: 'kolibri' }, { messages: de }).label, 'Kolibri');
  });

  it('agrees with each live target about name, label and trust boundary', () => {
    // The descriptor table restates the boundary the classes declare, and that
    // duplication is what this asserts away: a third-party target entered here as
    // self_hosted would silently turn the screenshot checkbox back to opt-out.
    const cases: Array<[Record<string, string>, string]> = [
      [KOLIBRI_ENV, 'kolibri'],
      [{ FEEDBACK_TARGET: 'fake' }, 'fake'],
    ];
    for (const [env, name] of cases) {
      const { target } = resolveFeedbackTarget(env);
      const descriptor = describeFeedbackTarget(env);
      assert.equal(target.name, name);
      assert.deepEqual(descriptor, { name: target.name, label: target.label, trustBoundary: target.trustBoundary });
    }
  });
});
