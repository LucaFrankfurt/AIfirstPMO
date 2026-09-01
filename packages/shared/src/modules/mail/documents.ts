/**
 * Which of forty thousand messages are worth a human's afternoon.
 *
 * The question this exists for is "find everything the accountant needs for
 * 2024", asked of four shared inboxes at once. Nothing here answers it, and
 * that is the design rather than a shortfall: what counts as tax-relevant is a
 * judgement about a business, it varies by jurisdiction and by year, and a
 * regex that decided it would be wrong in the expensive direction — a filter
 * that quietly drops an invoice is worse than no filter, because the person
 * using it has stopped looking.
 *
 * So this **ranks**, and says why. It turns the corpus into a few hundred
 * candidates with a reason attached to each, and the model that called the tool
 * reads them and decides. The score is a sorting key and never a threshold: no
 * caller filters on it, and `evidence` is returned alongside every hit so the
 * answer can say "because the attachment is called Rechnung_2024_08.pdf" rather
 * than "because 7".
 *
 * The vocabulary is German and English together for the reason `query.ts` is:
 * one inbox holds both, often in the same thread, and an invoice from Stripe
 * and one from the Steuerberater have to come back from the same search.
 */

/** A word that suggests money changed hands, and what it is worth. */
const SIGNALS: [RegExp, number, string][] = [
  // The document itself. Strongest, because these words are rarely small talk.
  [/\brechnung(en|s)?\b|\binvoice[sd]?\b|\bfactura\b/i, 5, 'invoice'],
  [/\bgutschrift(en)?\b|\bcredit note\b/i, 5, 'credit note'],
  [/\bbeleg(e|en)?\b|\breceipt[s]?\b|\bquittung(en)?\b/i, 4, 'receipt'],
  [/\bkontoauszug|\bbank statement\b|\bkontoauszüge\b/i, 4, 'bank statement'],
  [/\bsteuer(bescheid|erklärung|erklaerung|nummer)?\b|\btax (return|notice|statement|invoice)\b/i, 4, 'tax'],
  [/\bumsatzsteuer\b|\bvorsteuer\b|\bvat\b|\bmwst\.?\b|\bust\.?-?id\b/i, 4, 'VAT'],
  [/\bmahnung(en)?\b|\bdunning\b|\bzahlungserinnerung\b/i, 3, 'reminder'],
  [/\bvertrag\b|\bcontract\b|\bauftragsbestätigung\b|\border confirmation\b/i, 2, 'contract'],
  [/\bspende(nbescheinigung)?\b|\bdonation receipt\b/i, 3, 'donation'],
  [/\blohn|\bgehalt|\bpayroll\b|\bpayslip\b|\blohnabrechnung\b/i, 3, 'payroll'],
  // What it is about. Weaker on their own; decisive next to one of the above.
  [/\bzahlung(en|seingang)?\b|\bpayment\b|\bpaid\b|\bbezahlt\b/i, 2, 'payment'],
  [/\babonnement\b|\bsubscription\b|\bbilling\b|\babrechnung\b/i, 2, 'billing'],
  [/\bbetrag\b|\bamount due\b|\bsumme\b|\btotal\b/i, 1, 'amount'],
];

/**
 * A number that looks like money, in either notation.
 *
 * `1.234,56 €` and `€1,234.56` and `EUR 99.00`. Worth a point because a subject
 * line with a figure in it is doing something other than saying hello — and
 * only a point, because a marketing mail says `-50%` too.
 */
const MONEY = /(?:[€$£]\s?\d|(?:\b(?:eur|usd|gbp|chf)\b)\s?\d|\d[\d.,]*\s?(?:[€$£]|\b(?:eur|usd|gbp|chf)\b))/i;

/**
 * Extensions a document arrives as.
 *
 * A PDF is what an invoice is; a `.png` is what a signature block is. Both are
 * attachments, and treating them alike is how a search for documents returns
 * four hundred logos.
 */
const DOCUMENT_TYPES = /\.(pdf|xml|csv|xlsx?|odt|ods|docx?|p7s|zip)$/i;

/** ZUGFeRD, XRechnung, Factur-X: an invoice that is also a machine-readable file. */
const STRUCTURED = /\b(zugferd|xrechnung|factur-?x|ubl|e-?rechnung)\b/i;

export interface DocumentCandidate {
  subject: string;
  from: string;
  filenames: readonly string[];
  /** The plain-text body, or as much of it as is cheap to have here. */
  body?: string;
}

export interface DocumentVerdict {
  score: number;
  /** What was matched, in the order it was found. For showing, not for parsing. */
  evidence: string[];
}

/**
 * How likely this message is to be one the accountant wanted, and why.
 *
 * The filename counts double. It is the one part of a message written by a
 * machine that has already decided what the document is: `Rechnung_2024_08.pdf`
 * is a stronger claim about the contents than any subject line, because nobody
 * names a newsletter that.
 */
export function scoreDocument(candidate: DocumentCandidate): DocumentVerdict {
  const evidence: string[] = [];
  let score = 0;
  const subject = candidate.subject ?? '';
  const body = candidate.body ?? '';
  // Separators become spaces before anything is matched against them.
  // `\b` treats an underscore as a word character, so `Rechnung_2024_03.pdf`
  // did not match `\brechnung\b` — the single most common way a supplier
  // names an invoice, scoring zero on the strongest signal there is. The bug
  // was invisible: the message still ranked, on its subject, one row lower.
  const names = candidate.filenames.join(' ').replace(/[_.\-+]+/g, ' ');

  for (const [pattern, weight, label] of SIGNALS) {
    const inName = pattern.test(names);
    const inSubject = pattern.test(subject);
    if (!inName && !inSubject && !pattern.test(body)) continue;
    score += inName ? weight * 2 : inSubject ? weight : 1;
    evidence.push(inName ? `${label} in the filename` : inSubject ? `${label} in the subject` : `${label} in the body`);
  }

  const documents = candidate.filenames.filter((name) => DOCUMENT_TYPES.test(name));
  if (documents.length) {
    score += 3;
    evidence.push(`${documents.length} document attachment${documents.length === 1 ? '' : 's'}`);
  }
  if (STRUCTURED.test(names) || STRUCTURED.test(subject) || STRUCTURED.test(body)) {
    score += 4;
    evidence.push('structured e-invoice');
  }
  if (MONEY.test(subject)) {
    score += 1;
    evidence.push('an amount in the subject');
  }
  // An invoice number is the thing an accountant matches on, and it has a
  // shape: a word for it, then a run of digits, possibly across a slash.
  if (/\b(rechnungs?-?(nr|nummer)|invoice\s*(no|number|#)|beleg-?nr)\b[\s.:#]*[\w/-]*\d/i.test(`${subject} ${body}`)) {
    score += 3;
    evidence.push('an invoice number');
  }
  return { score, evidence };
}

/**
 * The filenames worth offering as documents, in the order they should be tried.
 *
 * Not a filter on the message — a message can be relevant with no attachment
 * at all, and a payment confirmation with the figures in the body is exactly
 * that case. This narrows the *files*, once a message is already a candidate.
 */
export const documentAttachments = (filenames: readonly string[]): string[] =>
  filenames.filter((name) => DOCUMENT_TYPES.test(name));

/** Is this file one somebody would file, rather than one the mail client made? */
export const looksLikeDocument = (filename: string): boolean => DOCUMENT_TYPES.test(filename);
