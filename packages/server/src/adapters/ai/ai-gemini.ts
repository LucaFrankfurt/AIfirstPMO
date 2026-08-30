/**
 * Gemini, over generateContent.
 *
 * The key goes in a header rather than the query string it is often shown in:
 * a URL travels into logs and proxies, and a header does not.
 *
 * The system prompt has its own field here (`systemInstruction`) rather than
 * being a message with a role, which is why `AiRequest` keeps the two apart
 * instead of handing every provider one blob of text to split up again.
 *
 * The rest of this file is about thinking, which is the thing that makes a
 * current Gemini model fail in a way that reads like something else entirely.
 */
import { env } from '../../kernel/platform/env.ts';
import { AiError, askProvider, detailOf, permanentStatus, type AiRequest } from './ai.ts';

const DEFAULT_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Room to think, on top of the room to answer.
 *
 * `maxOutputTokens` is one budget and the model spends it in order: thinking
 * first, answer second. A ceiling cut to fit the answer alone is how a
 * thinking model comes back with an empty candidate and `MAX_TOKENS` — or
 * worse, with half a JSON object, which arrives downstream as "the model
 * answered with something that was not a review" and sends whoever reads that
 * looking for a parser bug.
 *
 * So `maxTokens` keeps meaning what it says — the room for the answer — and
 * the room to think is added here. Nothing is billed for room that is not
 * used, and a model that does not think does not notice this.
 */
const THINKING_ROOM = 2048;

/**
 * How much thinking to ask for, and whether this model can be asked at all.
 *
 * `thinkingLevel` is a Gemini 3 field: sending it to 2.5 is an error rather
 * than a no-op, and so is sending a `thinkingConfig` to a model with no
 * thinking in it. The major version out of the model name is the only signal
 * there is, so anything that is not a recognisable `gemini-N` — a gateway with
 * names of its own — is asked for nothing, which is what happened here before.
 *
 * `LOW` rather than `MINIMAL` because every Gemini 3 model takes it. This is
 * the same call the Anthropic adapter makes for the same reason: a short piece
 * of JSON is not what deep reasoning is for, and it is billed by the token.
 */
function thinkingConfigFor(model: string): { thinkingLevel: string } | undefined {
  const major = Number(/(?:^|\/)gemini-(\d+)/.exec(model)?.[1] ?? 0);
  return major >= 3 ? { thinkingLevel: 'LOW' } : undefined;
}

interface Part {
  text?: string;
  /** True on a part that is the model thinking rather than answering. */
  thought?: boolean;
}

interface Reply {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
}

export async function reviewWithGemini(request: AiRequest): Promise<string> {
  const base = env.ai.baseUrl || DEFAULT_URL;
  const model = env.ai.model || DEFAULT_MODEL;
  const thinkingConfig = thinkingConfigFor(model);
  const response = await askProvider(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.ai.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        maxOutputTokens: request.maxTokens + THINKING_ROOM,
        // Asking for JSON in the prompt *and* here. The parser still does not
        // trust either — see `review.ts` — but a provider that can be told
        // costs nothing to tell.
        responseMimeType: 'application/json',
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    }),
  }, 'Gemini');

  if (!response.ok) {
    const detail = await detailOf(response);
    throw new AiError(
      `Gemini refused the request (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      permanentStatus(response.status),
    );
  }

  const reply = await response.json().catch(() => null) as Reply | null;
  const candidate = reply?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    // A thought part is prose *about* the answer, and it only comes back when
    // it is asked for. Joining it in anyway would be a corruption waiting for
    // that to change: one brace in the reasoning and `parseReview` reads the
    // model thinking out loud instead of its verdict. Parts are otherwise
    // joined rather than indexed, because a long answer arrives split.
    .filter((part) => !part.thought)
    .map((part) => part.text ?? '')
    .join('');

  // Out of room, which is not "a bad moment" — it will happen again on the
  // next click. Both sentences name the actual problem, because the truncated
  // half of a JSON object is otherwise reported as a model talking nonsense.
  if (candidate?.finishReason === 'MAX_TOKENS') {
    throw new AiError(
      text.trim()
        ? 'Gemini ran out of tokens part-way through the answer'
        : 'Gemini spent the whole token budget thinking and never got to the answer',
      true,
    );
  }

  if (!text.trim()) {
    // `SAFETY`, `RECITATION`, `PROHIBITED_CONTENT`: an empty 200 with the
    // reason sitting next to it, and no reason to make somebody guess.
    const why = candidate?.finishReason && candidate.finishReason !== 'STOP'
      ? ` (${candidate.finishReason})`
      : '';
    throw new AiError(`Gemini answered with nothing${why}`, false);
  }
  return text;
}
