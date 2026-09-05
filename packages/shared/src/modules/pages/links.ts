/**
 * What one page says about another.
 *
 * A wiki is a tree plus a web: the tree is `parent_id` and `sort_order`, and
 * this is the web. `[[Onboarding]]` in the middle of a sentence points at the
 * page called Onboarding — by **title**, not by id, because a link somebody
 * types has to be readable in the source and survive being pasted into a chat
 * message. The id is what the renderer produces; the title is what the author
 * wrote.
 *
 * Everything here is pure and takes the pages as an argument, for the reason
 * `pagetree.ts` is: the client already holds every page it may read, so
 * backlinks are arithmetic over a list rather than a round trip, and the
 * arithmetic is worth proving without a browser. The same functions answer for
 * MCP on the server, over rows out of SQLite.
 *
 * Three things are deliberately *not* here. There is no link table: a link
 * lives in the text that spells it, and a second copy in a row is a second
 * thing to keep true. There is no `[[Page#Heading]]`, because the renderer puts
 * no ids on headings and a link to an anchor that does not exist is worse than
 * no link. And there is no `![[embed]]`: transclusion means a page's rendering
 * depends on another page's text, which is a cycle waiting to happen and a
 * permission question nobody has asked yet.
 */

/** One `[[…]]` in a page, and where in the source it sits. */
export interface WikiLink {
  /** The title as written, trimmed. `[[ Onboarding | how we start ]]` → `Onboarding`. */
  target: string;
  /** What to show instead of the title, when the author gave one. */
  label: string | null;
  /** Offsets into the source, so a rewrite can splice rather than re-parse. */
  at: number;
  end: number;
}

/** The least a page has to say to take part in the web. */
export interface LinkablePage {
  id: string;
  title: string;
  content?: string | null;
  /** Ties are broken by age, so a resolution does not flip when a page is edited. */
  created_at?: number;
}

/**
 * The comparable form of a title.
 *
 * Case and runs of whitespace are noise — somebody typing `[[design review]]`
 * on a phone means the page called `Design Review` — and a title is trimmed
 * before it is stored anyway. Nothing else is folded: `Q1` and `q-1` are two
 * different pages and pretending otherwise would silently join them.
 */
export const pageKey = (title: string): string => title.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Whether a title can be the target of a link at all.
 *
 * `[[`, `]]` and `|` are the syntax, so a title containing one of them cannot
 * be written inside it — the link would end early and the rest would be prose.
 * Said out loud rather than escaped: an escape somebody has to know about is a
 * worse trap than a title they can see is unusual, and the interface can offer
 * the id instead when this is false.
 */
export const linkableTitle = (title: string): boolean => !/[[\]|\n]/.test(title);

/**
 * The source with everything the renderer treats as code blanked out, offsets
 * intact.
 *
 * Blanked rather than removed, so an offset into the result is an offset into
 * the original — which is what lets `renameLinks` splice the real string. The
 * two shapes are the two the renderer knows: a fenced block, and a code span.
 * Four-space indented code is not a code block here for the same reason it is
 * not one there.
 */
function withoutCode(source: string): string {
  const lines = source.split('\n');
  let fence: string | null = null;
  const kept = lines.map((line) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return ' '.repeat(line.length);
    }
    if (open) {
      fence = open[1];
      return ' '.repeat(line.length);
    }
    return line;
  });
  // Code spans after the fences, and only on the lines that survived them: a
  // stray backtick inside a fenced block must not pair with one outside it.
  return kept.join('\n').replace(/`[^`\n]+`/g, (span) => ' '.repeat(span.length));
}

/** `[[target]]`, `[[target|label]]`. Never across a line break — neither does Obsidian. */
const LINK = /\[\[([^[\]|\n]+)(?:\|([^[\]\n]*))?\]\]/g;

/** Every link in a page's markdown, in the order they are read. */
export function wikiLinks(source: string): WikiLink[] {
  const text = withoutCode(String(source ?? ''));
  const found: WikiLink[] = [];
  for (const match of text.matchAll(LINK)) {
    const target = match[1].trim();
    if (!target) continue;
    found.push({
      target,
      label: match[2] === undefined ? null : match[2].trim() || null,
      at: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/**
 * Look a title up among these pages.
 *
 * Two pages may carry the same title — nothing forbids it and people do it,
 * usually one per project. The rule is the least surprising one available:
 * whichever was written first wins, so a link that resolved yesterday resolves
 * to the same page today, and creating a second `Notes` does not silently move
 * every link in the workspace. An exact-case match beats a folded one, which is
 * how `[[FAQ]]` and `[[Faq]]` can be told apart when somebody has both.
 */
export function pageResolver<T extends LinkablePage>(pages: readonly T[]): (target: string) => T | undefined {
  const exact = new Map<string, T>();
  const folded = new Map<string, T>();
  const older = (a: T, b: T | undefined): boolean => !b || (a.created_at ?? 0) < (b.created_at ?? 0);
  for (const page of pages) {
    const title = String(page.title ?? '').trim();
    if (!title) continue;
    if (older(page, exact.get(title))) exact.set(title, page);
    const key = pageKey(title);
    if (older(page, folded.get(key))) folded.set(key, page);
  }
  return (target: string) => exact.get(target.trim()) ?? folded.get(pageKey(target));
}

/** Who points at whom, once, for a whole workspace. */
export interface LinkGraph {
  /** Page id → the pages it links to, each named once and in reading order. */
  out: Map<string, string[]>;
  /** Page id → the pages that link to it. */
  in: Map<string, string[]>;
  /** A title nothing resolves to → the pages asking for it. The wiki's to-write list. */
  missing: Map<string, string[]>;
}

/**
 * The whole web in one pass.
 *
 * Built rather than queried because the caller already has the pages: the
 * client syncs every page it may read, and the server holds them in one table.
 * A link out of a page nobody may see is simply not in the list that was handed
 * in — which is what keeps the visibility rule in the one place that owns it
 * instead of copied in here.
 *
 * A page never links to itself: `[[This page]]` written on the page it names is
 * a note to the reader, not an edge, and drawing it would put every such page
 * in its own backlinks.
 */
export function linkGraph<T extends LinkablePage>(pages: readonly T[]): LinkGraph {
  const resolve = pageResolver(pages);
  const graph: LinkGraph = { out: new Map(), in: new Map(), missing: new Map() };
  const push = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (!list) map.set(key, [value]);
    else if (!list.includes(value)) list.push(value);
  };
  for (const page of pages) {
    for (const link of wikiLinks(page.content ?? '')) {
      const found = resolve(link.target);
      if (!found) push(graph.missing, pageKey(link.target), page.id);
      else if (found.id !== page.id) {
        push(graph.out, page.id, found.id);
        push(graph.in, found.id, page.id);
      }
    }
  }
  return graph;
}

/**
 * The passage around a link, for a backlink somebody can read without opening
 * the page it came from.
 *
 * A list of titles answers "who links here" and nothing else; the question
 * people actually have is *why*, and the sentence containing the link is the
 * cheapest honest answer. The link itself is kept as its label rather than cut
 * out, so the quote reads the way the paragraph does.
 */
export function linkContext(source: string, target: string, max = 180): string | null {
  const text = withoutCode(String(source ?? ''));
  const key = pageKey(target);
  for (const link of wikiLinks(source)) {
    if (pageKey(link.target) !== key) continue;
    // The paragraph the link sits in, not the whole page: a blank line is where
    // one thought stops, and quoting past it quotes something else.
    const before = text.lastIndexOf('\n\n', link.at);
    const after = text.indexOf('\n\n', link.end);
    const paragraph = source.slice(before < 0 ? 0 : before + 2, after < 0 ? source.length : after);
    const shown = paragraph
      .replace(LINK, (_, title: string, label: string | undefined) => (label?.trim() || title.trim()))
      .replace(/[#>*_~`]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!shown) continue;
    return shown.length > max ? `${shown.slice(0, max)}…` : shown;
  }
  return null;
}

/**
 * Every `[[from]]` in this source rewritten to `[[to]]`, or the source
 * unchanged when there was nothing to do.
 *
 * Renaming a page breaks every link to it, and a wiki where that happens twice
 * is a wiki people stop linking in. The rewrite is deliberately narrow: only
 * links whose target resolves to the old title by `pageKey`, and only the
 * target — an author who wrote `[[Onboarding|how we start]]` chose those words
 * about the page, and a rename is not a reason to take them away.
 *
 * `null` means the new title cannot be linked to at all (see `linkableTitle`).
 * Returned rather than thrown, and rather than quietly writing a broken link,
 * because the caller is the only one that can say so to the person renaming.
 */
export function renameLinks(source: string, from: string, to: string): string | null {
  if (!linkableTitle(to)) return null;
  const text = String(source ?? '');
  const key = pageKey(from);
  const next = to.trim();
  const links = wikiLinks(text).filter((link) => pageKey(link.target) === key);
  if (!links.length) return text;
  let out = '';
  let cursor = 0;
  for (const link of links) {
    out += text.slice(cursor, link.at);
    out += link.label === null ? `[[${next}]]` : `[[${next}|${link.label}]]`;
    cursor = link.end;
  }
  return out + text.slice(cursor);
}
