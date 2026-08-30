/**
 * What this capability needs from a model, and nothing about whose it is.
 *
 * `review.ts` used to import all three provider files and switch on the name in
 * the configuration, which meant a capability knew every adapter that existed —
 * add a fourth provider and a capability had to be edited to learn about it.
 * This is the port instead: the shape of the question, the shape of a failure,
 * and a place for a provider to say it can answer. `adapters/ai/providers.ts`
 * fills it in and `wiring.ts` installs it.
 */
export interface AiRequest {
  /** The standing instructions. Identical on every call, so it caches well. */
  system: string;
  /** The task, as text. Everything that differs between two calls is here. */
  user: string;
  /** A ceiling, not a target. A review that hits it was going wrong anyway. */
  maxTokens: number;
}

/** Answers with the model's text, or throws `AiError`. */
export type Reviewer = (request: AiRequest) => Promise<string>;

/**
 * A model that did not answer, and whether asking again could help.
 *
 * `permanent` is the same idea as `DeliveryError.permanent` and is classified
 * the same way — in HTTP's terms, where 4xx is a request that will never work
 * and 5xx is a bad moment. Nothing retries here, because a person is waiting;
 * what it decides is whether the sentence they read says "try again" or
 * "somebody has to fix the configuration".
 */
export class AiError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'AiError';
    this.permanent = permanent;
  }
}

/** A provider, under the name the configuration calls it by. */
export interface Model {
  ask: Reviewer;
  /** The model actually used, which the review is stamped with. */
  model: string;
}

const providers = new Map<string, () => Model>();

/**
 * Offer to answer, under a configuration name.
 *
 * A thunk rather than a `Model`, because the model name is read from the
 * configuration at the moment of asking — a provider registered at startup must
 * not freeze what `KOLIBRI_AI_MODEL` said then.
 */
export function provideModel(name: string, make: () => Model): void {
  providers.set(name, make);
}

/** Whose model answers, and under what name. Null when none is configured. */
export const modelFor = (name: string): Model | null => providers.get(name)?.() ?? null;
