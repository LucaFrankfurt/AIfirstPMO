/**
 * Gemini, over generateContent.
 *
 * The key goes in a header rather than the query string it is often shown in:
 * a URL travels into logs and proxies, and a header does not.
 *
 * The system prompt has its own field here (`systemInstruction`) rather than
 * being a message with a role, which is why `AiRequest` keeps the two apart
 * instead of handing every provider one blob of text to split up again.
 */
import { env } from '../env.ts';
import { AiError, askProvider, detailOf, permanentStatus, type AiRequest } from './ai.ts';

const DEFAULT_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

interface Reply {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export async function reviewWithGemini(request: AiRequest): Promise<string> {
  const base = env.ai.baseUrl || DEFAULT_URL;
  const model = env.ai.model || DEFAULT_MODEL;
  const response = await askProvider(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.ai.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        // Asking for JSON in the prompt *and* here. The parser still does not
        // trust either — see `review.ts` — but a provider that can be told
        // costs nothing to tell.
        responseMimeType: 'application/json',
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
  const text = (reply?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('');
  if (!text.trim()) throw new AiError('Gemini answered with nothing', false);
  return text;
}
