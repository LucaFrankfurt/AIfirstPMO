/**
 * The document hunt, in one place, for the two surfaces that ask for it.
 *
 * `find_documents` over MCP and the Documents tab on screen are the same
 * question, and the repository's rule about two places stating one thing
 * applies to behaviour as much as to numbers: a ranking that differs between
 * the assistant and the screen is a ranking nobody can check the assistant's
 * work against. So both call this.
 *
 * The scoring itself is in `@kolibri/shared` — see `scoreDocument`, where the
 * argument for ranking rather than filtering is made at length. What is here is
 * the part that needs the database: widening the candidate set, fetching the
 * attachment names that carry most of the signal, and sorting.
 */
import { documentAttachments, scoreDocument, type MailFilter } from '@kolibri/shared';
import type { Row } from '../../kernel/platform/db/index.ts';
import { searchMail, type MailHit } from './search.ts';
import { attachmentsOf } from './store.ts';

export interface RankedMessage {
  message: MailHit;
  score: number;
  /** What was matched, in prose, so an answer can say why rather than "14". */
  why: string[];
  files: string[];
  documents: string[];
}

/**
 * How wide to cast before ranking.
 *
 * Deliberately wider than what comes back. The scoring reads subjects and
 * filenames, so a candidate set narrow enough to be cheap would already have
 * decided the question the scoring exists to answer — and a message whose only
 * clue is `Rechnung_2024_08.pdf` would never be in it.
 */
const CANDIDATES = 200;

export function rankDocuments(options: {
  workspaceId: string;
  mailboxIds: string[];
  filter: MailFilter;
  limit?: number;
}): { considered: number; ranked: RankedMessage[] } {
  const candidates = searchMail({ ...options, limit: CANDIDATES });
  const attachments = attachmentsOf(candidates.map((row) => String(row.id)));
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), CANDIDATES);

  const ranked = candidates
    .map((message) => {
      const files = (attachments.get(String(message.id)) ?? []).map((one: Row) => String(one.filename));
      // The snippet stands in for the body, which a search result does not
      // carry. It is the first two hundred characters, which is where an
      // invoice number usually is and where a newsletter's is not — so the
      // score is a little conservative on long messages and never invents a
      // reason. `why` says which half of the message each hit came from.
      const verdict = scoreDocument({
        subject: String(message.subject ?? ''),
        from: String(message.from_address ?? ''),
        filenames: files,
        body: String(message.snippet ?? ''),
      });
      return { message, score: verdict.score, why: verdict.evidence, files, documents: documentAttachments(files) };
    })
    .sort((a, b) => b.score - a.score || Number(b.message.sent_at) - Number(a.message.sent_at))
    .slice(0, limit);

  return { considered: candidates.length, ranked };
}
