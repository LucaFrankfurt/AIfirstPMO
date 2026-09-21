/**
 * Full-text search across everything, as one function.
 *
 * The route is a thin caller and so is MCP's `search` tool; the visibility
 * rules below are the interesting part and there must be exactly one of them.
 * It used to live in `routes/search.ts`, which meant `lib/mcp.ts` imported a
 * route — see `docs/modules.md` for why a library may not reach up into one.
 *
 * **Not everything is in `search_index`.** Most things are: a task, a page, a
 * comment are rows in one workspace with one visibility question, and one FTS
 * table over all of them is exactly right. Mail is not. A message is found by
 * words *and* by who sent it, when, and whether a PDF was attached, and folding
 * four unindexed columns onto every task and page to share one table would make
 * every other search pay for it. So mail keeps its own index — and the box over
 * everything still has to find it, or it is a box over most things.
 *
 * The answer is a **port**, not a branch. Teaching this file that a mailbox
 * exists would be the kernel leaning on a capability, which is the one thing
 * the module map is for. Instead a corpus registers itself from further out and
 * answers for its own rows, including who may see them — `registerCorpus`
 * below, filled by `capability/mail` through `wiring.ts`.
 */
import { identifiersIn, parseTerms, type SearchTerm } from '@kolibri/shared';
import { all, type Row } from '../platform/db/index.ts';
import { canSeeBudget, canSeeProject } from '../write-path/repo.ts';

export interface SearchHit {
  kind: string;
  id: string;
  project_id: string | null;
  title: string;
  snippet: string;
  rank: number;
}

/**
 * FTS5 expects a query language; people type prose. `parseTerms` reads the
 * prose — see `@kolibri/shared`, where the grammar lives so that the client
 * matching its own rows and the index answering the same question cannot drift
 * apart — and this turns what it found into a MATCH.
 *
 * Three shapes come out of it, and the second and third are the point:
 *
 *   rechnung            "rechnung"*                  a word, still being typed
 *   "design review"     "design review"              those words, in that order
 *   -intern             (…) NOT ("intern"*)          and not that
 *
 * Every word has already been through `fold` and a split on non-word
 * characters, so a `"` cannot survive into one and the quoting below cannot be
 * escaped out of. That is worth saying out loud: this string is concatenated
 * into a MATCH rather than bound, because FTS5 has no parameter for half a
 * query, and the safety is the tokeniser rather than a `replace` somebody could
 * later decide was redundant.
 *
 * A query of nothing but exclusions compiles to nothing at all. `NOT ("x"*)`
 * with no left-hand side is an FTS5 syntax error, and "everything except" is
 * not a search anybody meant to run against a whole workspace.
 */
export function toMatchQuery(input: string): string {
  return toMatch(parseTerms(input));
}

function toMatch(terms: readonly SearchTerm[]): string {
  const wanted = terms.filter((term) => !term.negated).map(asPhrase);
  if (!wanted.length) return '';
  const unwanted = terms.filter((term) => term.negated).map(asPhrase);
  const required = wanted.join(' AND ');
  return unwanted.length ? `(${required}) NOT (${unwanted.join(' OR ')})` : required;
}

const asPhrase = (term: SearchTerm): string => `"${term.words.join(' ')}"${term.prefix ? '*' : ''}`;

/**
 * A word in a title outweighs the same word buried in a description.
 *
 * `bm25` takes one weight per column — including the four the table does not
 * index, which still occupy their argument positions — so the two numbers at
 * the end are `title` and `body`. Without them a page whose *name* is
 * "Rechnungen" lost to a task that happened to say the word four times in a
 * paragraph, which is never what somebody typing one word is after. The web
 * list has always sorted its own rows that way; this is the index catching up.
 *
 * Five rather than something larger: a comment and a message have no title at
 * all, and a weight big enough to make the ordering feel decisive is also big
 * enough to push everything that can only ever match in `body` off the end.
 */
const RANK = 'bm25(search_index, 0.0, 0.0, 0.0, 0.0, 5.0, 1.0)';

/**
 * A body of text with an index and a visibility rule of its own.
 *
 * `find` is handed the person as well as the workspace and is expected to have
 * already dropped what they may not read — the same contract the clauses below
 * keep for `search_index`. There is no filtering of a corpus's answer here,
 * deliberately: a corpus that returned rows its caller then had to check would
 * be a second place the rule lived, which is how a rule with two spellings goes
 * wrong.
 */
export interface Corpus {
  /** The `kind` its hits carry, so a `kinds` filter can skip it entirely. */
  kind: string;
  find(scope: { workspaceId: string; userId: string; query: string; limit: number }): SearchHit[];
}

const corpora: Corpus[] = [];

/**
 * @port a corpus with an index and a visibility rule of its own
 *
 * Idempotent on the kind, the way `onEntity` and `onWrite` are: registering the
 * same corpus twice is a no-op rather than a doubled result set, which matters
 * because `wiring.ts` may be installed more than once in a process that both
 * boots the server and seeds it.
 */
export function registerCorpus(corpus: Corpus): void {
  if (!corpora.some((one) => one.kind === corpus.kind)) corpora.push(corpus);
}

/**
 * Two rankings that cannot be compared, merged into one list.
 *
 * `bm25` is relative to the table it came from: it depends on how many
 * documents there are and how long the average one is, so a −8 from
 * `search_index` and a −8 from `mail_index` mean nothing to each other.
 * Sorting the concatenation by score would look principled and be arbitrary —
 * and the arbitrariness would land as "mail always wins" or "mail never
 * appears", depending on which corpus happened to be larger.
 *
 * So the merge is by **position within each corpus** rather than by score:
 * every corpus's best hit, then every corpus's second, and so on. What that
 * claims is only what is true — each corpus knows its own order, and none of
 * them knows the others' — and it has the property the flat list needs, which
 * is that a single mail matching a word nothing else matches is near the top
 * rather than off the end.
 */
function interleave(lists: SearchHit[][], limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  for (let position = 0; out.length < limit; position += 1) {
    let any = false;
    for (const list of lists) {
      if (position >= list.length) continue;
      any = true;
      out.push(list[position]);
      if (out.length >= limit) break;
    }
    if (!any) break;
  }
  return out;
}

export function searchWorkspace(workspaceId: string, userId: string, query: string, limit = 30, kinds?: string[]): SearchHit[] {
  const terms = parseTerms(query);
  const match = toMatch(terms);
  if (!match) return [];
  // The kind goes into the query rather than into a filter over its result:
  // asking for pages and cutting the list afterwards means a page ranked
  // thirty-first is never seen, however few pages there are.
  const wanted = kinds?.filter(Boolean) ?? [];
  const kindClause = wanted.length ? ` AND kind IN (${wanted.map(() => '?').join(', ')})` : '';
  const rows = all<Row>(
    `SELECT kind, ref_id, project_id, title, snippet(search_index, 5, '', '', '…', 12) AS snippet, ${RANK} AS rank
       FROM search_index
      WHERE search_index MATCH ? AND (workspace_id = ? OR workspace_id IS NULL)${kindClause}
      ORDER BY rank LIMIT ?`,
    match, workspaceId, ...wanted, Math.min(limit * 3, 200),
  );
  // The index also holds rows belonging to no workspace: a direct conversation
  // is between two people rather than inside an organisation, and it would be
  // odd for it to be findable from one workspace and not another. Only
  // messages are ever in that state, and the membership check below is what
  // makes including them safe.
  //
  // A message's visibility is its channel's, and the index does not carry the
  // channel. Resolved in one query for the whole page of hits rather than one
  // per row — and *before* the slice, so a private conversation cannot push a
  // readable result off the end of the list either.
  const readable = visibleMessages(userId, rows.filter((row) => row.kind === 'message').map((row) => String(row.ref_id)));

  const indexed = rows
    .filter((row) => canSeeProject(userId, row.project_id)
      && (row.kind !== 'message' || readable.has(String(row.ref_id)))
      // A budget covering several projects has no single `project_id`, so the
      // clause above reads it as workspace-wide and lets it through. Asked of
      // the one function that knows the scoping rule — see `canSeeBudget`.
      && (row.kind !== 'budget' || canSeeBudget(userId, String(row.ref_id))))
    .map((row) => ({
      kind: row.kind,
      id: row.ref_id,
      project_id: row.project_id ?? null,
      title: row.title || row.snippet || '',
      snippet: row.snippet ?? '',
      rank: Number(row.rank ?? 0),
    }));

  // Somebody who typed `FEE-1` gets `FEE-1` first, above whatever else the
  // index thought of the words. Deduplicated rather than appended: the phrase
  // the identifier compiles to matches that task's own title, so without this
  // it would be in the list twice, once pinned and once earned.
  const named = namedTasks(workspaceId, userId, identifiersIn(terms), wanted);
  const pinned = new Set(named.map((hit) => hit.id));
  const ordered = named.length
    ? [...named, ...indexed.filter((hit) => !(hit.kind === 'task' && pinned.has(hit.id)))]
    : indexed;

  // Asked for the full `limit` each, not a share of it: a corpus that returns
  // nothing must not cost the others anything, and `interleave` does the
  // trimming. A corpus that throws is a corpus that is missing from this
  // answer, never one that empties it — the box going blank because an inbox
  // is unreachable would be a worse failure than the gap it is covering.
  const extra = corpora
    .filter((corpus) => !wanted.length || wanted.includes(corpus.kind))
    .map((corpus) => {
      try {
        return corpus.find({ workspaceId, userId, query, limit });
      } catch {
        return [];
      }
    })
    .filter((list) => list.length > 0);

  return extra.length ? interleave([ordered, ...extra], limit) : ordered.slice(0, limit);
}

/**
 * The tasks somebody named outright, rather than described.
 *
 * `FEE-1` is how this team refers to a task out loud, and it is the one search
 * where the right answer is a single row and everybody knows which. Left to the
 * index alone it is a phrase like any other and lands wherever bm25 puts it,
 * which for a short title against a long description is not always first.
 *
 * Read from `tasks` rather than from the index on purpose: `identifier` is a
 * column with a unique meaning, and asking it directly is both exact and
 * cheaper than asking FTS5 for a phrase it would then have to be trusted about.
 * The same two exclusions the index applies — deleted and archived — because a
 * short cut into the archive would find what every list in the app hides.
 */
function namedTasks(workspaceId: string, userId: string, identifiers: string[], kinds: string[]): SearchHit[] {
  if (!identifiers.length || (kinds.length && !kinds.includes('task'))) return [];
  const rows = all<Row>(
    `SELECT id, identifier, title, project_id FROM tasks
      WHERE workspace_id = ? AND deleted_at IS NULL AND COALESCE(archived, 0) = 0
        AND identifier IN (${identifiers.map(() => '?').join(', ')})`,
    workspaceId, ...identifiers,
  );
  return rows
    .filter((row) => canSeeProject(userId, row.project_id))
    // Ranked ahead of anything bm25 can produce, which is always negative and
    // never this far down. The number is only ever read as an order.
    .map((row) => ({
      kind: 'task',
      id: String(row.id),
      project_id: row.project_id ? String(row.project_id) : null,
      title: `${row.identifier ?? ''} ${row.title ?? ''}`.trim(),
      snippet: '',
      rank: -Infinity,
    }));
}

/**
 * Which of these messages this person may read.
 *
 * The same rule the sync filter and `canSeeChannel` apply, asked once for a
 * whole page of hits. A message in a channel that has since been deleted is
 * not readable either — the join drops it.
 */
function visibleMessages(userId: string, ids: string[]): Set<string> {
  if (!ids.length) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = all<Row>(
    `SELECT m.id, c.project_id, c.is_private, c.members
       FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE m.id IN (${placeholders}) AND c.deleted_at IS NULL`,
    ...ids,
  );
  const allowed = new Set<string>();
  for (const row of rows) {
    if (!canSeeProject(userId, row.project_id)) continue;
    if (Number(row.is_private) && !memberIds(row.members).includes(userId)) continue;
    allowed.add(String(row.id));
  }
  return allowed;
}

const memberIds = (raw: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};
