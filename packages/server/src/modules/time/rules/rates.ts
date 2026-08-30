/**
 * What an hour costs, and the shape a rate has to be in.
 */

import { RATE_KINDS } from '@kolibri/shared';
import { type EntityRule } from '../../../kernel/write-path/repo.ts';

/**
 * A rate is money and a day, and both have to be storable.
 *
 * Corrections rather than refusals, as the budget invariants are and for the
 * same reason — these arrive in sync batches from devices that have been away.
 * A negative rate becomes zero rather than being kept: an hour that earns money
 * back is not a thing, and a minus somebody typed by accident would quietly
 * subtract from every project they touched.
 */
function applyRateInvariants(values: Record<string, unknown>, forced: Record<string, unknown>): void {
  const settle = (field: string, value: unknown) => { values[field] = value; forced[field] = value; };

  if (values.kind !== undefined && !(RATE_KINDS as readonly string[]).includes(String(values.kind))) {
    settle('kind', 'cost');
  }
  if (values.amount !== undefined) {
    const amount = Math.round(Number(values.amount));
    if (!Number.isFinite(amount) || amount < 0) settle('amount', 0);
    else if (amount !== values.amount) settle('amount', amount);
  }
  if (typeof values.currency === 'string') {
    const code = values.currency.trim().toUpperCase();
    settle('currency', /^[A-Z]{3}$/.test(code) ? code : 'EUR');
  }
  // A rate that starts on nothing in particular would sort before or after
  // every other depending on how SQLite felt about the string.
  if (values.starts_on !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(values.starts_on ?? ''))) {
    settle('starts_on', new Date().toISOString().slice(0, 10));
  }
}



export const rateRules = {
  entities: ['rate'],
  defaults(entity, id, values, opts, setForced) {
    if (entity === 'rate' && !values.starts_on) {
      setForced('starts_on', new Date().toISOString().slice(0, 10));
    }
  },
  invariants(entity, id, values, existing, forced) {
    applyRateInvariants(values, forced);
  },
} satisfies EntityRule;
