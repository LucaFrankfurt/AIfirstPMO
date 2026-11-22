/**
 * OpenRouter, and through it whatever model somebody points it at.
 *
 * The request is the shape half the industry copied from OpenAI, which is also
 * what a local gateway in front of a model on the same machine tends to speak
 * — so `KOLIBRI_AI_BASE_URL` plus this adapter is the way to a self-hosted
 * model without a fourth file.
 *
 * `KOLIBRI_AI_MODEL` has no default worth having here: OpenRouter routes to
 * hundreds of models and picking one for somebody is picking their bill.
 */
import { env } from '../../kernel/platform/env.ts';
import { AiError, askProvider, detailOf, permanentStatus, type AiRequest } from './ai.ts';

const DEFAULT_URL = 'https://openrouter.ai/api';
export const DEFAULT_MODEL = 'anthropic/claude-opus-4.5';

/**
 * Gateways whose models are told what to cache, rather than deciding it.
 *
 * Anthropic's models cache nothing through OpenRouter unless a part of the
 * prompt is marked, and the mark is Anthropic's own `cache_control`, which
 * OpenRouter passes on; Google's take the same mark. Measured on 22 November
 * 2026: a support widget's eight pages, about 9,450 tokens, were billed in full
 * on every call through OpenRouter — 2.1 cents a call with Sonnet — while the
 * same request straight to Anthropic was cached from the second call on.
 *
 * By the model's namespace, which on OpenRouter names who serves it. Anything
 * else is sent the plain string it always was: a model that caches by itself
 * needs no mark, and a gateway on this machine that speaks the same shape is
 * not asked to understand one.
 */
const MARKS_CACHE = ['anthropic/', 'google/'];

type Part = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/** The user's turn: one string, or the part that is the same every time marked for caching. */
function contentOf(request: AiRequest, model: string): string | Part[] {
  const cut = Math.min(request.cachePrefix ?? 0, request.user.length);
  if (cut <= 0 || cut >= request.user.length || !MARKS_CACHE.some((prefix) => model.startsWith(prefix))) return request.user;
  return [
    { type: 'text', text: request.user.slice(0, cut), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: request.user.slice(cut) },
  ];
}

interface Reply {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: { message?: string };
}

export async function reviewWithOpenRouter(request: AiRequest): Promise<string> {
  const base = env.ai.baseUrl || DEFAULT_URL;
  const model = request.model || env.ai.model || DEFAULT_MODEL;
  const response = await askProvider(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.ai.key}`,
      // Both are optional and both are courtesies: they are what OpenRouter
      // shows in its own dashboard next to the spend.
      'x-title': 'Kolibri',
      ...(env.publicUrl ? { 'http-referer': env.publicUrl } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: contentOf(request, model) },
      ],
    }),
  }, 'OpenRouter', request.timeoutMs);

  if (!response.ok) {
    const detail = await detailOf(response);
    throw new AiError(
      `OpenRouter refused the request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      permanentStatus(response.status),
    );
  }

  const reply = await response.json().catch(() => null) as Reply | null;
  // A 200 carrying an error object. OpenRouter answers this way when the model
  // behind it failed rather than the gateway, and the status says nothing.
  if (reply?.error?.message) throw new AiError(`OpenRouter: ${reply.error.message}`, false);
  // `length` is OpenAI's word for the token ceiling, and every gateway that
  // copied the shape copied it too. The answer is truncated JSON, so say so
  // here rather than letting `parseReview` blame the model for it.
  if (reply?.choices?.[0]?.finish_reason === 'length') {
    throw new AiError('OpenRouter ran out of tokens before the answer was finished', true);
  }
  const text = reply?.choices?.[0]?.message?.content ?? '';
  if (!text.trim()) throw new AiError('OpenRouter answered with nothing', false);
  return text;
}
