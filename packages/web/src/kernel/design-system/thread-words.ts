/**
 * A thread's words, from the app's own catalogue and clocks.
 *
 * `conversation.tsx` takes its words as a prop so that it can be drawn where
 * the app's catalogue is not loaded — the support widget's page. Everything
 * inside the app gets them from here.
 */
import { useMemo } from 'react';
import type { ThreadWords } from './conversation';
import { clockTime, exactTime, longDate } from './format';
import { useT } from '../i18n/i18n';

export function useThreadWords(): ThreadWords {
  const t = useT();
  return useMemo(() => ({
    today: t('chat.today'),
    yesterday: t('chat.yesterday'),
    sending: t('thread.sending'),
    seen: t('thread.seen'),
    typing: t('thread.typing'),
    typingNamed: (name: string) => t('thread.typingNamed', { name }),
    actions: t('chat.messageActions'),
    attach: t('thread.attach'),
    placeholder: t('thread.placeholder'),
    send: t('thread.send'),
    clock: clockTime,
    exact: exactTime,
    day: longDate,
  }), [t]);
}
