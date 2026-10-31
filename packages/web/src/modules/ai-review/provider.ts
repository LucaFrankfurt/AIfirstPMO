/**
 * Whether this server has a model, asked of it once.
 *
 * Shared by the two things that ask a model — a task review and a board drawn
 * on a canvas — so the answer is fetched once per page load, whichever of
 * them is opened first.
 */
import { useEffect, useState } from 'react';
import { api } from '../../kernel/sync/api';

/**
 * Whether this server can reach a model at all.
 *
 * Asked once per page load and remembered: the answer is a property of the
 * instance, not of the task, and one fetch per task sheet would be a request
 * per click. A failure — offline, most likely — reads as "no", which is the
 * right direction: there is no reviewing anything without a network.
 */
let asked: Promise<{ provider: string } | null> | null = null;

export function useAiProvider(): string | null {
  const [provider, setProvider] = useState<string | null>(null);
  useEffect(() => {
    asked ??= api.config().then((config) => config.ai).catch(() => null);
    let live = true;
    asked.then((ai) => { if (live) setProvider(ai?.provider ?? null); });
    return () => { live = false; };
  }, []);
  return provider;
}
