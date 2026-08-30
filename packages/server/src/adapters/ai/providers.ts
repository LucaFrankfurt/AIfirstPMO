/**
 * The three providers, offered to whoever wants a model.
 *
 * `review.ts` used to import all three of these and switch on the configured
 * name itself. It says what it needs now — `modules/ai-review/model.ts` — and
 * this says who can supply it, so a fourth provider is a file here and a line
 * in `wiring.ts` rather than an edit to a capability.
 */
import { env } from '../../kernel/platform/env.ts';
import { provideModel } from '../../modules/ai-review/model.ts';
import { DEFAULT_MODEL as ANTHROPIC_MODEL, reviewWithAnthropic } from './ai-anthropic.ts';
import { DEFAULT_MODEL as GEMINI_MODEL, reviewWithGemini } from './ai-gemini.ts';
import { DEFAULT_MODEL as OPENROUTER_MODEL, reviewWithOpenRouter } from './ai-openrouter.ts';

/** Hung off ai-review by `wiring.ts`. */
export function installAiProviders(): void {
  provideModel('anthropic', () => ({ ask: reviewWithAnthropic, model: env.ai.model || ANTHROPIC_MODEL }));
  provideModel('gemini', () => ({ ask: reviewWithGemini, model: env.ai.model || GEMINI_MODEL }));
  provideModel('openrouter', () => ({ ask: reviewWithOpenRouter, model: env.ai.model || OPENROUTER_MODEL }));
}
