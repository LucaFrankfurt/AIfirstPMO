/** What the catalogue screens share: row order, the switched-off screen, the horizon, a term's label. */
import { DEFAULT_ASSUMPTIONS, compareOrder, type Product, type ProductPrice, type PromotionBreakEven } from '@kolibri/shared';
import { Empty } from '../../kernel/design-system/ui/empty';
import { useT } from '../../kernel/i18n/i18n';

/**
 * Rows in the order somebody put them, with a tie-break that is not chance.
 *
 * The same comparator the budget screens use and for the same reason: rows
 * carrying the schema's default key — which is what anything created over REST
 * or by an import has — would otherwise come out in whatever order the sort
 * happened to leave them, and a different order on the next render.
 */
export const byOrder = (a: { sort_order?: string; created_at: number }, b: { sort_order?: string; created_at: number }) =>
  compareOrder(a.sort_order ?? '', b.sort_order ?? '') || a.created_at - b.created_at;

/** The screen every catalogue route shows when the workspace has not switched it on. */
export function SwitchedOff() {
  const t = useT();
  return <Empty emoji="🔕" title={t('product.offTitle')} hint={t('product.offHint')} />;
}

/**
 * The horizon every figure on these screens is read over.
 *
 * Twelve months and one delivery, which is `DEFAULT_ASSUMPTIONS` — stated here
 * as a reference to it rather than as two literals, because a break-even the
 * screen computes over twelve months and one an assistant computes over
 * something else is the disagreement this whole arrangement exists to prevent.
 */
export const HORIZON = { months: DEFAULT_ASSUMPTIONS.months, deliveries: DEFAULT_ASSUMPTIONS.deliveries };

/* ----------------------------------------------------- capability vocabulary */

/**
 * What a price's commitment reads as, and where the number came from.
 *
 * A price that states none is not blank: it commits to whatever the product
 * says, and showing nothing there would make an inherited twelve months look
 * like no commitment at all. The inherited figure is shown in the product's
 * own words with a mark, so the column can be read down without opening a row.
 */
/**
 * A commitment, as a chip stands on its own.
 *
 * `termLabel` below answers under a column headed "Term", where "none" reads
 * fine. A chip has no header over it, so it has to carry the noun itself.
 */
export function termChip(t: ReturnType<typeof useT>, months: number): string {
  return months === 0 ? t('product.termFree') : t('product.termMonthsShort', { months: String(months) });
}

export function termLabel(t: ReturnType<typeof useT>, price: ProductPrice, product: Product): string {
  const months = price.term_months ?? product.term_months;
  const said = months === 0 ? t('product.termNone') : t('product.termMonthsShort', { months: String(months) });
  return price.term_months === null ? `${said} *` : said;
}

/**
 * The break-even as a sentence, because two of its three answers are not numbers.
 *
 * It names no unit. `unit_label` is a word the organisation typed, in the
 * singular — "Platz", "Lizenz", "Tag" — and "ab 45 Platz im Monat" is what
 * putting it after a count reads as. No locale here can decline a word it was
 * handed, so the sentence is written not to need one.
 */
export function payback(t: ReturnType<typeof useT>, answer: PromotionBreakEven): string {
  if (answer.kind === 'always') return t('product.paysAlways');
  if (answer.kind === 'never') {
    return t(answer.why === 'no-price' ? 'product.paysNoPrice'
      : answer.why === 'no-uplift' ? 'product.paysNoUplift'
        : 'product.paysNeverSmall');
  }
  return t('product.paysAbove', { units: String(answer.units) });
}
