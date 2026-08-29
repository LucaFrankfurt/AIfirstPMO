/**
 * A figure, and a box to type one into.
 *
 * Here rather than in `components/budget.tsx`, where they started, because
 * three capabilities that have nothing to do with each other need them:
 * budgets, the rate screens under time tracking, and the infrastructure
 * register costing a component. Each was reaching into another's file for
 * them, which is how those three ended up in an import knot — see
 * `docs/modules.md`. A currency is furniture, not a feature.
 */
import { useState } from 'react';
import { formatMoney, parseMoney, type Minor } from '@kolibri/shared';
import { currentLocale } from '../../lib/i18n';
import { Input } from './field';

/** A figure, in the reader's language. Cents only where cents are the point. */
export const asMoney = (minor: Minor, currency: string, compact = false): string =>
  formatMoney(minor, currency, currentLocale(), { compact });

/**
 * An amount, typed.
 *
 * Kept as text while somebody is in it and parsed when they leave, so a
 * half-typed `12.` is not repeatedly reformatted under the cursor — which is
 * what every currency input that formats on each keystroke does, and why they
 * are so unpleasant to use. `parseMoney` reads whichever separators they used.
 */
export function MoneyInput({ value, currency, onChange, ...rest }: {
  value: Minor;
  currency: string;
  onChange: (minor: Minor) => void;
  id?: string;
  placeholder?: string;
  'aria-label'?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value ? (value / 100).toFixed(2) : '');
  return (
    <Input
      {...rest}
      inputMode="decimal"
      className="money-input"
      value={shown}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) onChange(parseMoney(draft) ?? 0);
        setDraft(null);
      }}
      title={currency}
    />
  );
}
