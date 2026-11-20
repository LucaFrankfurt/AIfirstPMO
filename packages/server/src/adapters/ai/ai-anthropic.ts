/**
 * Claude, over the Messages API.
 *
 * Two details here are not obvious from the shape of the request and cost an
 * afternoon each if they are missed.
 *
 * The reply is a list of blocks, not a string, and on a model that thinks the
 * first block is the thinking rather than the answer. Reading `content[0]`
 * works on the model you tried it with and returns an empty string on the next
 * one, so the text is *found* rather than indexed.
 *
 * And thinking is on by default on the current models. For a short piece of
 * JSON that is latency and tokens spent on nothing, so effort is asked down to
 * `low` — which is the documented way to make it cheap. Turning thinking off
 * outright is not: it has failure modes of its own, and it is not what this
 * needs.
 */
import { env } from '../../kernel/platform/env.ts';
import { AiError, askProvider, detailOf, permanentStatus, type AiRequest } from './ai.ts';

const DEFAULT_URL = 'https://api.anthropic.com';
export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Models that may hand a declined request to another model inside the same
 * call, and the beta that asks them to.
 *
 * A support visitor whose question a safety classifier declines got nothing
 * back but a hand-over, and a review got an error; with `fallbacks: 'default'`
 * the API itself routes a decline to a model suited to it, and bills that
 * model's rates for what it writes. Named, not inferred from a prefix: a model
 * outside this list answers the field with a 400, and `KOLIBRI_AI_MODEL` can
 * name any model there is.
 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLS_BACK = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/**
 * The prompt as the Messages API takes it: one string, or — when the caller
 * says how much of it is the same every time — that part as a block of its own
 * marked for caching, so a support widget's knowledge pages are read at the
 * cached rate from the second visitor on. A prefix shorter than the provider's
 * minimum is simply not cached; nothing fails.
 */
function contentOf(request: AiRequest): string | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] {
  const cut = Math.min(request.cachePrefix ?? 0, request.user.length);
  if (cut <= 0 || cut >= request.user.length) return request.user;
  return [
    { type: 'text', text: request.user.slice(0, cut), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: request.user.slice(cut) },
  ];
}

interface Block { type: string; text?: string }
interface Reply { content?: Block[]; stop_reason?: string; model?: string }

export async function reviewWithAnthropic(request: AiRequest): Promise<string> {
  const base = env.ai.baseUrl || DEFAULT_URL;
  const model = request.model || env.ai.model || DEFAULT_MODEL;
  const fallsBack = FALLS_BACK.has(model);
  const response = await askProvider(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ai.key,
      'anthropic-version': '2023-06-01',
      ...(fallsBack ? { 'anthropic-beta': FALLBACK_BETA } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      output_config: { effort: request.effort ?? 'low' },
      messages: [{ role: 'user', content: contentOf(request) }],
      ...(fallsBack ? { fallbacks: 'default' } : {}),
    }),
  }, 'Anthropic', request.timeoutMs);

  if (!response.ok) {
    const detail = await detailOf(response);
    throw new AiError(
      `Anthropic refused the request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      permanentStatus(response.status),
    );
  }

  const reply = await response.json().catch(() => null) as Reply | null;
  // A safety refusal is a 200 with nothing in it worth reading. Saying so is
  // better than handing the parser an empty string and reporting bad JSON.
  // With fallbacks on, this is the whole chain having declined.
  if (reply?.stop_reason === 'refusal') {
    throw new AiError('Anthropic declined to answer for this task', true);
  }
  // Cut off at `max_tokens`. Whatever text came back is half a JSON object,
  // and handing that to the parser reports a model talking nonsense when the
  // truth is a ceiling — one that will be there again on the next click, which
  // is what makes this permanent rather than a bad moment.
  if (reply?.stop_reason === 'max_tokens') {
    throw new AiError('Anthropic ran out of tokens before it finished the answer', true);
  }
  const text = (reply?.content ?? []).find((block) => block.type === 'text')?.text ?? '';
  if (!text.trim()) throw new AiError('Anthropic answered with nothing', false);
  return text;
}
