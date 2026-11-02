import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matches } from './helpers.ts';
import { buildFeedbackForm, submitFeedback } from '../src/adapters/capture/submit.ts';
import { readFeedbackForm } from '../src/kernel/feedback/input.ts';

describe('buildFeedbackForm', () => {
  it('writes exactly the fields the server half reads — and no identity', () => {
    const form = buildFeedbackForm({
      kind: 'BUG',
      message: 'kaputt',
      clientContext: { url: '/x' },
      screenshot: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
    });
    assert.deepEqual([...form.keys()].sort(), ['clientContext', 'kind', 'message', 'screenshot']);
    assert.equal(form.get('clientContext'), '{"url":"/x"}');
    assert.equal((form.get('screenshot') as File).name, 'screenshot.jpg');
  });

  it('omits the screenshot for a text-only report', () => {
    assert.equal(buildFeedbackForm({ kind: 'BUG', message: 'x' }).has('screenshot'), false);
  });

  it("round-trips through the server's reader", async () => {
    const form = buildFeedbackForm({
      kind: 'IDEA',
      message: 'Filter merken',
      clientContext: { viewport: '390x844' },
      screenshot: new Blob([new Uint8Array([7, 8])], { type: 'image/webp' }),
    });
    const read = await readFeedbackForm(
      new Request('https://app.example/api/feedback', { method: 'POST', body: form }),
    );
    matches(read, { kind: 'IDEA', message: 'Filter merken', clientContext: { viewport: '390x844' } });
    assert.deepEqual(Array.from(read.screenshot!.bytes), [7, 8]);
  });
});

describe('submitFeedback', () => {
  it("returns the stored report's id", async () => {
    const result = await submitFeedback(
      '/api/feedback',
      { kind: 'BUG', message: 'x' },
      {
        fetch: async () => new Response(JSON.stringify({ ok: true, id: 'rep-1' }), { status: 201 }),
      },
    );
    assert.deepEqual(result, { ok: true, id: 'rep-1' });
  });

  it("hands back the server's message for the reporter on a refusal", async () => {
    const result = await submitFeedback(
      '/api/feedback',
      { kind: 'BUG', message: 'x' },
      {
        fetch: async () => new Response(JSON.stringify({ error: 'Zu viele Rückmeldungen' }), { status: 429 }),
      },
    );
    assert.deepEqual(result, { ok: false, status: 429, error: 'Zu viele Rückmeldungen' });
  });

  it('copes with a refusal that is not JSON', async () => {
    const result = await submitFeedback(
      '/api/feedback',
      { kind: 'BUG', message: 'x' },
      {
        fetch: async () => new Response('<html>Bad gateway</html>', { status: 502 }),
      },
    );
    assert.deepEqual(result, { ok: false, status: 502, error: null });
  });

  it("rejects when there was no answer at all, so the caller can say 'network error'", async () => {
    await assert.rejects(
      submitFeedback(
        '/api/feedback',
        { kind: 'BUG', message: 'x' },
        {
          fetch: () => Promise.reject(new TypeError('Failed to fetch')),
        },
      ),
      (error: Error) => error.message.includes('Failed to fetch'),
    );
  });
});
