/**
 * Reviewing a task: the three ways out, and the one place a model is trusted.
 *
 * Two questions here, and the second is the one that keeps somebody's Tuesday.
 *
 * Does each adapter send what its provider expects and read the answer back
 * out of the right place — including the case that is easy to get away with in
 * a first draft, where the answer is the *second* block because the first one
 * is the model thinking.
 *
 * And does `parseReview` refuse everything a model can plausibly send that is
 * not a review: prose, JSON in a fence, valid JSON offering to rewrite a field
 * this app will not let it touch, a replacement identical to what is already
 * there. Everything downstream of that function acts on what it returns, so a
 * bug there ends with a click writing an empty title over somebody's task.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-ai-${process.pid}`;

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { rmSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import { AiError, permanentStatus } from '../src/lib/ai.ts';
import { reviewWithAnthropic } from '../src/lib/ai-anthropic.ts';
import { reviewWithGemini } from '../src/lib/ai-gemini.ts';
import { reviewWithOpenRouter } from '../src/lib/ai-openrouter.ts';
import { parseReview } from '../src/lib/review.ts';
import type { Row } from '../src/db/index.ts';

/** A task to review, and the thing a replacement is compared against. */
const task = {
  id: 't1',
  title: 'Export',
  description: 'It is slow.',
  updated_at: 1700000000000,
} as unknown as Row;

const ask = { system: 'You review tasks.', user: 'Title: Export', maxTokens: 500 };

/* ------------------------------------------------------------- a provider */

interface Fake {
  server: Server;
  /** Every request the adapter made: its path, headers and parsed body. */
  seen: { path: string; headers: Record<string, string>; body: any }[];
}

/** A provider that answers however the test tells it to. */
async function fakeProvider(reply: (body: any) => { status?: number; json?: unknown; text?: string }): Promise<Fake> {
  const seen: Fake['seen'] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ path: req.url ?? '', headers: req.headers as Record<string, string>, body });
      const answer = reply(body);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen };
}

const urlOf = (fake: Fake): string => `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;

/** The adapters read `env` at call time, so a test sets it and puts it back. */
async function withProvider(fake: Fake, config: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const { env } = await import('../src/env.ts');
  const before = { ...env.ai };
  Object.assign(env.ai, { key: 'k', model: '', baseUrl: urlOf(fake), timeoutMs: 4000, ...config });
  try {
    await run();
  } finally {
    Object.assign(env.ai, before);
    fake.server.close();
  }
}

/* ------------------------------------------------------------------ Claude */

describe('the Anthropic adapter', () => {
  it('sends the key in a header and finds the text among the blocks', async () => {
    const fake = await fakeProvider(() => ({
      json: {
        // Thinking first, deliberately. `content[0].text` is undefined here,
        // which is exactly the bug this case exists to fail on.
        content: [
          { type: 'thinking', thinking: 'weighing it up' },
          { type: 'text', text: '{"verdict":"clear"}' },
        ],
      },
    }));
    await withProvider(fake, { model: 'claude-opus-5' }, async () => {
      const text = await reviewWithAnthropic(ask);
      assert.equal(text, '{"verdict":"clear"}');
      const [call] = fake.seen;
      assert.equal(call.path, '/v1/messages');
      assert.equal(call.headers['x-api-key'], 'k');
      assert.equal(call.headers['anthropic-version'], '2023-06-01');
      assert.equal(call.body.model, 'claude-opus-5');
      assert.equal(call.body.system, ask.system);
      assert.equal(call.body.messages[0].content, ask.user);
      // Thinking costs latency a short piece of JSON has no use for.
      assert.equal(call.body.output_config.effort, 'low');
    });
  });

  it('calls a refusal a refusal rather than bad JSON', async () => {
    const fake = await fakeProvider(() => ({ json: { stop_reason: 'refusal', content: [] } }));
    await withProvider(fake, {}, async () => {
      await assert.rejects(reviewWithAnthropic(ask), (error: AiError) => {
        assert.match(error.message, /declined/);
        assert.equal(error.permanent, true);
        return true;
      });
    });
  });

  it('calls a truncated answer a ceiling rather than a bad review', async () => {
    const fake = await fakeProvider(() => ({
      json: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"verdict":"needs-' }] },
    }));
    await withProvider(fake, {}, async () => {
      await assert.rejects(reviewWithAnthropic(ask), (error: AiError) => {
        assert.match(error.message, /ran out of tokens/);
        assert.equal(error.permanent, true);
        return true;
      });
    });
  });

  it('says a bad key is permanent and a bad moment is not', async () => {
    const refused = await fakeProvider(() => ({ status: 401, text: 'invalid x-api-key' }));
    await withProvider(refused, {}, async () => {
      await assert.rejects(reviewWithAnthropic(ask), (error: AiError) => {
        assert.equal(error.permanent, true);
        assert.match(error.message, /invalid x-api-key/);
        return true;
      });
    });

    const busy = await fakeProvider(() => ({ status: 529, text: 'overloaded' }));
    await withProvider(busy, {}, async () => {
      await assert.rejects(reviewWithAnthropic(ask), (error: AiError) => {
        assert.equal(error.permanent, false);
        return true;
      });
    });
  });
});

/* ------------------------------------------------------------------ Gemini */

describe('the Gemini adapter', () => {
  it('puts the key in a header and the system prompt in its own field', async () => {
    const fake = await fakeProvider(() => ({
      json: { candidates: [{ content: { parts: [{ text: '{"verdict":' }, { text: '"clear"}' }] } }] },
    }));
    await withProvider(fake, { model: 'gemini-2.5-flash' }, async () => {
      const text = await reviewWithGemini(ask);
      // Parts are joined rather than [0] taken: a long answer arrives split.
      assert.equal(text, '{"verdict":"clear"}');
      const [call] = fake.seen;
      assert.equal(call.path, '/v1beta/models/gemini-2.5-flash:generateContent');
      assert.equal(call.headers['x-goog-api-key'], 'k');
      // Never the query string: a URL ends up in logs and proxies.
      assert.ok(!call.path.includes('k'), 'the key must not be in the URL');
      assert.equal(call.body.systemInstruction.parts[0].text, ask.system);
      assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
      // 2.5 has no `thinkingLevel`, and sending it there is an error rather
      // than a field that gets ignored.
      assert.equal(call.body.generationConfig.thinkingConfig, undefined);
    });
  });

  it('asks a Gemini 3 model to think as little as it is allowed to', async () => {
    const fake = await fakeProvider(() => ({
      json: { candidates: [{ content: { parts: [{ text: '{"verdict":"clear"}' }] } }] },
    }));
    await withProvider(fake, { model: 'gemini-3.6-flash' }, async () => {
      await reviewWithGemini(ask);
      assert.equal(fake.seen[0].body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    });
  });

  it('leaves a name it does not recognise alone', async () => {
    const fake = await fakeProvider(() => ({
      json: { candidates: [{ content: { parts: [{ text: '{"verdict":"clear"}' }] } }] },
    }));
    // A gateway on the same network, named however its operator named it. A
    // `thinkingConfig` sent to a model that has no thinking in it is an error.
    await withProvider(fake, { model: 'house-model-v2' }, async () => {
      await reviewWithGemini(ask);
      assert.equal(fake.seen[0].body.generationConfig.thinkingConfig, undefined);
    });
  });

  it('leaves room for the thinking on top of the room for the answer', async () => {
    const fake = await fakeProvider(() => ({
      json: { candidates: [{ content: { parts: [{ text: '{"verdict":"clear"}' }] } }] },
    }));
    await withProvider(fake, { model: 'gemini-3.6-flash' }, async () => {
      await reviewWithGemini(ask);
      // The ceiling is one budget spent thinking first and answering second.
      // Sized for the answer alone, it is the answer that gets cut off.
      assert.ok(
        fake.seen[0].body.generationConfig.maxOutputTokens > ask.maxTokens,
        'the ceiling has to hold more than the answer',
      );
    });
  });

  it('reads past the thinking to the answer', async () => {
    const fake = await fakeProvider(() => ({
      json: {
        candidates: [{
          content: {
            parts: [
              // Prose about the answer, with a brace in it. Joined in, this is
              // what `parseReview` would try to read as the review.
              { text: 'Let me draft {something} first.', thought: true },
              { text: '{"verdict":"clear"}' },
            ],
          },
        }],
      },
    }));
    await withProvider(fake, { model: 'gemini-3.6-flash' }, async () => {
      assert.equal(await reviewWithGemini(ask), '{"verdict":"clear"}');
    });
  });

  it('calls a truncated answer a ceiling rather than a bad review', async () => {
    const cut = await fakeProvider(() => ({
      json: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"verdict":"needs-' }] } }] },
    }));
    await withProvider(cut, { model: 'gemini-3.6-flash' }, async () => {
      await assert.rejects(reviewWithGemini(ask), (error: AiError) => {
        assert.match(error.message, /ran out of tokens/);
        // It will do it again on the next click. Retrying is not the advice.
        assert.equal(error.permanent, true);
        return true;
      });
    });

    // The same ceiling, reached before a word of the answer: a thinking model
    // on a budget that only ever fitted the answer.
    const silent = await fakeProvider(() => ({
      json: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] },
    }));
    await withProvider(silent, { model: 'gemini-3.6-flash' }, async () => {
      await assert.rejects(reviewWithGemini(ask), (error: AiError) => {
        assert.match(error.message, /thinking/);
        return true;
      });
    });
  });

  it('carries the reason an empty answer was empty', async () => {
    const fake = await fakeProvider(() => ({
      json: { candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] },
    }));
    await withProvider(fake, { model: 'gemini-2.5-flash' }, async () => {
      await assert.rejects(reviewWithGemini(ask), (error: AiError) => {
        assert.match(error.message, /SAFETY/);
        return true;
      });
    });
  });
});

/* -------------------------------------------------------------- OpenRouter */

describe('the OpenRouter adapter', () => {
  it('speaks the shape a gateway understands', async () => {
    const fake = await fakeProvider(() => ({
      json: { choices: [{ message: { content: '{"verdict":"clear"}' } }] },
    }));
    await withProvider(fake, { model: 'some/model' }, async () => {
      assert.equal(await reviewWithOpenRouter(ask), '{"verdict":"clear"}');
      const [call] = fake.seen;
      assert.equal(call.path, '/v1/chat/completions');
      assert.equal(call.headers.authorization, 'Bearer k');
      assert.equal(call.body.messages[0].role, 'system');
      assert.equal(call.body.messages[1].content, ask.user);
    });
  });

  it('calls a truncated answer a ceiling rather than a bad review', async () => {
    const fake = await fakeProvider(() => ({
      json: { choices: [{ finish_reason: 'length', message: { content: '{"verdict":"needs-' } }] },
    }));
    await withProvider(fake, {}, async () => {
      await assert.rejects(reviewWithOpenRouter(ask), (error: AiError) => {
        assert.match(error.message, /ran out of tokens/);
        assert.equal(error.permanent, true);
        return true;
      });
    });
  });

  it('notices an error delivered with a 200', async () => {
    const fake = await fakeProvider(() => ({ json: { error: { message: 'no credits' } } }));
    await withProvider(fake, {}, async () => {
      await assert.rejects(reviewWithOpenRouter(ask), (error: AiError) => {
        assert.match(error.message, /no credits/);
        return true;
      });
    });
  });
});

describe('classifying a status', () => {
  it('treats 4xx as final and 429 and 5xx as a bad moment', () => {
    assert.equal(permanentStatus(400), true);
    assert.equal(permanentStatus(401), true);
    assert.equal(permanentStatus(404), true);
    assert.equal(permanentStatus(429), false);
    assert.equal(permanentStatus(500), false);
    assert.equal(permanentStatus(529), false);
  });
});

/* ------------------------------------------------------ the only trust point */

describe('reading a model’s answer', () => {
  const parse = (text: string) => parseReview(text, 'test-model', task);

  it('takes JSON wearing a code fence, or with a sentence in front of it', () => {
    assert.equal(parse('```json\n{"verdict":"clear","summary":"Fine."}\n```').summary, 'Fine.');
    assert.equal(parse('Sure! Here you go:\n{"verdict":"clear","summary":"Fine."}').summary, 'Fine.');
  });

  it('refuses prose rather than half-reading it', () => {
    assert.throws(() => parse('I think this task could use more detail.'), /not a review/);
    assert.throws(() => parse('{"verdict": nope}'), /not a review/);
    assert.throws(() => parse(''), /not a review/);
  });

  it('drops a finding that would write a field a review may not touch', () => {
    const review = parse(JSON.stringify({
      verdict: 'needs-work',
      summary: 'Two things.',
      findings: [
        { kind: 'title', problem: 'Names a component.', field: 'title', replacement: 'Export times out over 5k tasks' },
        { kind: 'other', problem: 'Nobody owns it.', field: 'assignees', replacement: 'ada' },
      ],
    }));
    assert.equal(review.findings.length, 2);
    assert.equal(review.findings[0].field, 'title');
    // Kept as an observation, stripped of the button that would have written
    // somewhere this app does not let a review write.
    assert.equal(review.findings[1].field, undefined);
    assert.equal(review.findings[1].replacement, undefined);
    assert.equal(review.findings[1].problem, 'Nobody owns it.');
  });

  it('drops a replacement that is what the task already says', () => {
    const review = parse(JSON.stringify({
      verdict: 'needs-work',
      summary: 'Hmm.',
      findings: [{ kind: 'title', problem: 'Could be clearer.', field: 'title', replacement: 'Export' }],
    }));
    assert.equal(review.findings[0].field, undefined);
  });

  it('lets the findings settle the verdict when the model disagrees with itself', () => {
    const review = parse(JSON.stringify({
      verdict: 'clear',
      summary: 'All good.',
      findings: [{ kind: 'scope', problem: 'This is three tasks.' }],
    }));
    assert.equal(review.verdict, 'needs-work');
  });

  it('keeps an unknown kind as “other” rather than failing on it', () => {
    const review = parse(JSON.stringify({
      verdict: 'needs-work',
      summary: 'One thing.',
      findings: [{ kind: 'vibes', problem: 'Reads oddly.' }],
    }));
    assert.equal(review.findings[0].kind, 'other');
  });

  it('carries the questions and remembers which version it read', () => {
    const review = parse(JSON.stringify({
      verdict: 'needs-work',
      summary: 'Needs a fact.',
      findings: [],
      questions: ['Which export — CSV or JSON?', '   ', 42],
    }));
    assert.deepEqual(review.questions, ['Which export — CSV or JSON?']);
    assert.equal(review.reviewed_at, 1700000000000);
    assert.equal(review.model, 'test-model');
  });

  it('answers “clear” with a sentence even when the model sent none', () => {
    const review = parse('{"verdict":"clear","findings":[],"questions":[]}');
    assert.equal(review.verdict, 'clear');
    assert.ok(review.summary.length > 0);
  });
});

after(() => rmSync(`/tmp/kolibri-ai-${process.pid}`, { recursive: true, force: true }));
