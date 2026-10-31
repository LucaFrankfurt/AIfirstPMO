/**
 * The model, offered to a canvas.
 *
 * A canvas asks for a board through `CanvasAi`, which the page route hands it
 * from here — `ai-review` already leans on pages, so the arrow goes this way
 * and never back. Null whenever the answer would be a refusal: no model on
 * the server, the workspace's switch off, or a reader who could not put the
 * answer anywhere. The canvas then offers nothing, rather than a button that
 * explains why it cannot work.
 */
import { useMemo } from 'react';
import type { CanvasAi } from '../pages/canvas-dialogs';
import { api } from '../../kernel/sync/api';
import { useCanWrite, useFeature } from '../../kernel/identity/session';
import { useAiProvider } from './provider';

/**
 * Providers whose models have one name. OpenRouter is missing on purpose: it
 * routes to whatever model the operator configured, Claude or not, and the
 * server does not tell the client which.
 */
const NAMES: Record<string, string> = { anthropic: 'Claude', gemini: 'Gemini' };

export function useBoardAi(): CanvasAi | null {
  const provider = useAiProvider();
  const switchedOn = useFeature('ai');
  const canWrite = useCanWrite();
  return useMemo(
    () => (provider && switchedOn && canWrite
      ? { name: NAMES[provider] ?? null, draft: (pageId, request) => api.draftBoard(pageId, request) }
      : null),
    [provider, switchedOn, canWrite],
  );
}
