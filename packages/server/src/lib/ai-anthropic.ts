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
import { env } from '../env.ts';
import { AiError, askProvider, detailOf, permanentStatus, type AiRequest } from './ai.ts';

const DEFAULT_URL = 'https://api.anthropic.com';
export const DEFAULT_MODEL = 'claude-opus-5';

interface Block { type: string; text?: string }
interface Reply { content?: Block[]; stop_reason?: string; model?: string }

export async function reviewWithAnthropic(request: AiRequest): Promise<string> {
  const base = env.ai.baseUrl || DEFAULT_URL;
  const response = await askProvider(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ai.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.ai.model || DEFAULT_MODEL,
      max_tokens: request.maxTokens,
      system: request.system,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: request.user }],
    }),
  }, 'Anthropic');

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
  if (reply?.stop_reason === 'refusal') {
    throw new AiError('Anthropic declined to answer for this task', true);
  }
  const text = (reply?.content ?? []).find((block) => block.type === 'text')?.text ?? '';
  if (!text.trim()) throw new AiError('Anthropic answered with nothing', false);
  return text;
}
