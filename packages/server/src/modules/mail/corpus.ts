/**
 * Mail, in the box over everything.
 *
 * The Mail screen and `search_mail` have always found a message; the one search
 * box at the top of the app did not, because mail keeps its own FTS table and
 * the kernel's search knew only about `search_index`. That gap was quiet in the
 * way that matters: the box said "no results" for a word that was sitting in an
 * inbox, and there was nothing to suggest it had not looked.
 *
 * It is closed by registering rather than by the kernel learning about
 * mailboxes. `search.ts` declares `registerCorpus` and this fills it — which is
 * the direction rule 5 requires, and also the only arrangement in which the
 * *visibility* stays in one place: this function resolves the readable
 * mailboxes exactly as every other reader does, so the box inherits the rule
 * rather than restating it. A restricted mailbox is not findable from the
 * search box by somebody not on its list, and nothing in the kernel had to be
 * told that such a thing exists.
 *
 * What is deliberately *not* passed through: the dialect. `von:stripe
 * seit:2024` is the Mail screen's language, and the box over everything already
 * has one of its own — `@`, `#` and `+`. Two query languages in one field is a
 * field nobody can predict, so the words go through as words and the prefixes
 * stay where they were learnt.
 */
import { registerCorpus, type Corpus, type SearchHit } from '../../kernel/search/search.ts';
import { visibleMailboxes } from './mailboxes.ts';
import { searchMail } from './search.ts';

/**
 * The `kind` a mail hit carries.
 *
 * `mail` rather than `email`, matching the vocabulary the rest of the feature
 * uses — the entity is a `mailbox`, the screen is Mail, the tools are
 * `search_mail`. A second word for one thing is how a `kinds` filter comes to
 * be written against a spelling nothing emits.
 */
export const MAIL_KIND = 'mail';

const mailCorpus: Corpus = {
  kind: MAIL_KIND,
  find({ workspaceId, userId, query, limit }): SearchHit[] {
    // `visibleMailboxes` answers "nothing" for a workspace with mail switched
    // off, so the feature flag needs no separate check here — and could not
    // usefully have one, since this runs for every workspace on the instance.
    const mailboxes = visibleMailboxes(userId, workspaceId);
    if (!mailboxes.length) return [];

    return searchMail({
      workspaceId,
      mailboxIds: mailboxes.map((row) => String(row.id)),
      filter: { text: query },
      limit,
    }).map((row, position) => ({
      kind: MAIL_KIND,
      id: String(row.id),
      // A message belongs to a mailbox rather than to a project, so there is no
      // project to name — and `null` is the honest answer rather than a
      // convenient one: the kernel reads it as workspace-wide, and the row has
      // already been through the mailbox rule, which is the stricter check.
      project_id: null,
      title: String(row.subject || '(no subject)'),
      // Who it is from, ahead of the text. In a list mixed with tasks and pages
      // the sender is what tells somebody at a glance which of these rows is an
      // email, and the subject alone often does not.
      snippet: `${row.from_name || row.from_address} — ${row.snippet ?? ''}`.trim(),
      // Position rather than a score. `searchMail` orders by date, not by
      // relevance, so a bm25 number here would be an invention; the kernel
      // merges by position anyway and this is what it reads.
      rank: position,
    }));
  },
};

/** `wiring.ts` calls this. A corpus nobody registers is a corpus that does not exist. */
export function installMailCorpus(): void {
  registerCorpus(mailCorpus);
}
