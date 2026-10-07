/**
 * What is wrong with a wiki, counted rather than felt.
 *
 * A handbook does not get messy all at once. It accumulates: a page started
 * and abandoned, a second `Notes` that quietly takes half the links away from
 * the first, a sub-page whose parent was archived and which therefore reappears
 * at the top level pretending to be a chapter. Every one of those is invisible
 * in the tree — the tree draws a confident answer either way — and none of them
 * is reported anywhere. So "tidy up the wiki" was a job with no list, which
 * means it was a job nobody did.
 *
 * Pure and apart from the store, like `pagetree.ts` beside it and for the same
 * reason: the interesting part is which pages count as what, the edge cases are
 * off-by-one questions about empty content and shared titles, and both are
 * worth proving without a browser. The component reads the pages out of the
 * store and draws the answer.
 *
 * `linkGraph` is called here rather than passed in, so this cannot come to
 * disagree with the backlinks on a page about who points at whom.
 */
import { linkGraph, pageExcerpt, pageKey } from '@kolibri/shared';

/**
 * The least a page has to say to be assessed.
 *
 * Deliberately not `Page`: everything here is arithmetic over seven fields,
 * and a test that has to build a whole row to ask whether an empty page is
 * empty is a test nobody adds a case to.
 */
export interface TidyPage {
  id: string;
  title: string;
  content?: string | null;
  format?: string | null;
  parent_id: string | null;
  updated_at: number;
  created_at?: number;
  /**
   * What the page's rung *means* — never its name.
   *
   * Resolved by the caller with `kindOf`, so this file holds no opinion about
   * what a workspace calls anything and keeps working when somebody renames
   * "Im Review" to "Gegenlesen". Absent on a caller that has no ladder, which
   * simply means the finding below never fires.
   */
  statusKind?: string | null;
}

/**
 * The five things worth telling somebody about, and nothing else.
 *
 * They are findings, not errors. Every one of them is a page somebody meant to
 * write, so the screen offers to archive or open them and never to fix them in
 * bulk — a wiki that tidies itself is a wiki that loses a draft.
 */
export type Problem = 'detached' | 'duplicate' | 'empty' | 'isolated' | 'stale' | 'inReview';

/**
 * The order the findings are worked through, and the argument for it.
 *
 * `detached` first because it is the only one where the tree is actually
 * lying: the page draws at the top level as though somebody put it there.
 * `duplicate` second because it silently moves links — the consequence lands
 * on *other* pages, which is what makes it hard to notice. Then the two about
 * content, then `inReview`, which is somebody waiting on somebody, and `stale`
 * last, because "nobody has touched it" is the one that is often simply true
 * of a finished document.
 */
export const PROBLEMS: readonly Problem[] = ['detached', 'duplicate', 'empty', 'isolated', 'inReview', 'stale'];

/** A page nobody has edited in this long is worth a second look, not a verdict. */
export const STALE_DAYS = 180;

/**
 * How long a page may sit on a `review` rung before it is worth saying so.
 *
 * Far shorter than `STALE_DAYS`, and the difference is the whole point: a
 * finished document nobody touched for six months is usually fine, while a page
 * somebody *asked* to have read and nobody came back to is a promise that has
 * been broken for a month. The two numbers measure the same elapsed time and
 * mean opposite things by it.
 */
export const REVIEW_DAYS = 30;

export interface Finding<T> {
  problem: Problem;
  pages: T[];
}

export interface Tidied<T> {
  /** Each finding that has anything in it, in `PROBLEMS` order. */
  findings: Finding<T>[];
  /** Page id → what was found about it, for a badge on a row drawn elsewhere. */
  byPage: Map<string, Problem[]>;
  /** How many distinct pages are named at all — the number worth putting on a button. */
  pages: number;
}

/**
 * Anything that puts something on a page without putting words on it.
 *
 * `pageExcerpt` answers "what does this page say", which is the right question
 * for a preview card and the wrong one on its own here: it extracts *text*, so
 * a page whose whole body is `![Architektur](diagram.png)` or
 * `<figure><img …></figure>` reduces to the empty string. Reported as "nothing
 * written yet" on a screen whose bar offers Archive and Delete, that is a page
 * holding a real diagram one click from being thrown away as a blank draft.
 */
const MEDIA = /!\[[^\]]*\]\([^)]*\)|<\s*(img|svg|video|audio|iframe|embed|object|picture|canvas|table)\b/i;

/**
 * Whether a page has anything on it.
 *
 * `pageExcerpt` rather than `content.trim()`, because both readers of a page
 * body agree with it and a hand-rolled test would not: an HTML page whose body
 * is `<p></p>` has characters in it and nothing on it, and markdown front
 * matter is the same shape of lie. A page with *only* its own title as a
 * heading also reads as empty, and deliberately is not treated as such — that
 * is a page somebody structured and has not filled, which is the normal first
 * minute of writing one.
 *
 * Text *or* media, for the reason above `MEDIA`.
 */
const isEmpty = (page: TidyPage): boolean =>
  !pageExcerpt(page.content, page.format, 40).trim() && !MEDIA.test(page.content ?? '');

/**
 * Read the whole wiki and say what is in the way.
 *
 * `pages` is what the caller may see and nothing else — the archive, the
 * templates and other people's private pages are left out by whoever reads
 * them out of the store, which keeps the visibility rule in the one place that
 * owns it. `all` is the wider list the tree is checked *against*, and it has to
 * include **tombstones**: a parent that was archived, deleted or made into a
 * template is still a row, and the difference between those three is not worth
 * three findings. Handed a list that a plain `list()` produced, the deleted
 * case silently never fires — the caller is `routes/tidy.tsx`, and the note
 * above its `known` says what that cost.
 */
export function tidyPages<T extends TidyPage>(
  pages: readonly T[],
  options: { all?: readonly TidyPage[]; now?: number; staleDays?: number; reviewDays?: number } = {},
): Tidied<T> {
  const now = options.now ?? Date.now();
  const staleAfter = (options.staleDays ?? STALE_DAYS) * 24 * 60 * 60 * 1000;
  const reviewAfter = (options.reviewDays ?? REVIEW_DAYS) * 24 * 60 * 60 * 1000;
  const live = new Set(pages.map((page) => page.id));
  const known = new Set((options.all ?? pages).map((page) => page.id));
  const hasChildren = new Set(pages.map((page) => page.parent_id).filter((id): id is string => !!id));
  const links = linkGraph(pages);

  // Which titles more than one page answers to. Counted over the folded form,
  // because that is the form `pageResolver` resolves against — two pages called
  // `Design Review` and `design review` are one target with one winner.
  const byTitle = new Map<string, T[]>();
  for (const page of pages) {
    const key = pageKey(page.title ?? '');
    if (!key) continue;
    const same = byTitle.get(key);
    if (same) same.push(page);
    else byTitle.set(key, [page]);
  }

  const found = new Map<Problem, T[]>(PROBLEMS.map((problem) => [problem, []]));
  const byPage = new Map<string, Problem[]>();
  const note = (problem: Problem, page: T) => {
    found.get(problem)!.push(page);
    const on = byPage.get(page.id);
    if (on) on.push(problem);
    else byPage.set(page.id, [problem]);
  };

  for (const page of pages) {
    // A parent that is not in the list the tree was built from. `known` tells
    // the two cases apart only to be sure this is not reporting a page whose
    // parent is simply in a project the reader cannot open — that one is left
    // alone, because nothing can be done about it from here.
    if (page.parent_id && !live.has(page.parent_id) && known.has(page.parent_id)) note('detached', page);
    if (isEmpty(page) && !hasChildren.has(page.id)) note('empty', page);
    if (
      !page.parent_id
      && !hasChildren.has(page.id)
      && !(links.in.get(page.id) ?? []).length
    ) note('isolated', page);
    if (now - page.updated_at > staleAfter) note('stale', page);
    // Measured from the last edit, which is the only date a page carries. That
    // is a little generous — somebody who puts a page up for review and then
    // fixes a typo starts the clock again — and generous is the right side to
    // err on for a finding whose remedy is to go and nudge a colleague.
    if (page.statusKind === 'review' && now - page.updated_at > reviewAfter) note('inReview', page);
  }

  // Grouped so the pages that share a title sit together: a list of nine rows
  // in last-edited order says nothing, and "these three are all called Notes"
  // is the whole finding.
  for (const [, same] of [...byTitle].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (same.length < 2) continue;
    for (const page of [...same].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))) {
      note('duplicate', page);
    }
  }

  // `duplicate` is noted in the second loop above, so a page's own list came
  // out with it last whatever `PROBLEMS` says — and `byPage` exists to put a
  // badge on a row, where the first one shown is the one the ordering argument
  // is about. Sorted here rather than by making the loops agree, because the
  // grouping *has* to happen after the per-page pass.
  for (const [id, on] of byPage) {
    if (on.length > 1) byPage.set(id, [...on].sort((a, b) => PROBLEMS.indexOf(a) - PROBLEMS.indexOf(b)));
  }

  return {
    findings: PROBLEMS.map((problem) => ({ problem, pages: found.get(problem)! })).filter((one) => one.pages.length > 0),
    byPage,
    pages: byPage.size,
  };
}
