/**
 * The wiki's web, read out of the synced store.
 *
 * `@kolibri/shared`'s `links.ts` does the arithmetic; this is the half that
 * knows where the pages are. Every page a person may read is already in the
 * cache — that is what offline-first buys — so "who links here" is a scan of a
 * list rather than a round trip, and it answers on a train like everything
 * else. Nothing here talks to the server.
 *
 * The scan is deliberately not memoised across components. `useQuery` re-runs
 * only when the store's revision changes, and a workspace's pages are hundreds
 * of rows rather than millions; a cache keyed on "all the pages" would be a
 * second copy of the store with its own invalidation bug in it.
 */
import { useMemo } from 'react';
import {
  linkContext, linkGraph, linkableTitle, pageKey, pageResolver, renameLinks, wikiLinks, type Page,
} from '@kolibri/shared';
import { list, useQuery } from '../../kernel/sync/store';
import { update } from '../../kernel/sync/mutations';
import { useCanWrite, useSession } from '../../kernel/identity/session';

/**
 * Where a page lives when it is being linked to.
 *
 * Archived pages are in, and templates too. A link is written about a page that
 * exists, and turning it into "write this page" the moment somebody archives it
 * is how a workspace ends up with two pages called Onboarding.
 */
const linkable = (workspaceId: string): Page[] =>
  list('page', (page) => page.workspace_id === workspaceId);

/**
 * What `[[…]]` resolves to for this reader, as the renderer asks for it.
 *
 * A title nothing answers to becomes a link to the page that would be written —
 * `/pages/new?title=…` creates it — but only for somebody who may write. A guest
 * offered a link that will refuse them is worse than plain text, so they get
 * the brackets, which at least say a page was meant.
 *
 * The title rides in the query rather than in the path, and that is not a
 * style choice: `Q3 plan / draft` is a perfectly ordinary title, and a `%2F`
 * inside a path segment is decoded before the router matches, so the route
 * simply never matched and the link landed on Page not found.
 */
export function usePageHref(): (target: string) => { href: string; missing?: boolean } | undefined {
  const { workspaceId } = useSession();
  const canWrite = useCanWrite();
  const pages = useQuery(() => linkable(workspaceId), [workspaceId]);
  return useMemo(() => {
    const resolve = pageResolver(pages);
    return (target: string) => {
      const found = resolve(target);
      if (found) return { href: `/pages/${found.id}` };
      return canWrite ? { href: `/pages/new?title=${encodeURIComponent(target.trim())}`, missing: true } : undefined;
    };
  }, [pages, canWrite]);
}

/** One page that links here, and the sentence it said it in. */
export interface Backlink {
  page: Page;
  context: string | null;
}

/**
 * The pages pointing at this one, most recently edited first.
 *
 * Ordered by edit rather than by title because a backlink list answers "what is
 * this page part of", and the answer people want first is the thing somebody is
 * working on. Archived pages are left out here even though they resolve above:
 * they are still real enough to link *to*, and not real enough to be evidence
 * that a page is in use.
 */
export function useBacklinks(pageId: string): Backlink[] {
  const { workspaceId } = useSession();
  const pages = useQuery(() => linkable(workspaceId), [workspaceId]);
  return useMemo(() => {
    const graph = linkGraph(pages);
    const byId = new Map(pages.map((page) => [page.id, page]));
    const title = byId.get(pageId)?.title ?? '';
    return (graph.in.get(pageId) ?? [])
      .map((id) => byId.get(id))
      .filter((page): page is Page => !!page && !page.archived)
      .sort((a, b) => b.updated_at - a.updated_at)
      // Quoted by title rather than by id, which is the same thing: a link
      // resolves by title, so every link that reached this page was written
      // with this page's title, whatever its case or its alias.
      .map((page) => ({ page, context: linkContext(page.content ?? '', title) }));
  }, [pages, pageId]);
}

/**
 * The pages between the root of the tree and this one, outermost first.
 *
 * Without it the tree exists only on the index: a page opened from a search, a
 * link or a bookmark said nothing about where it sat, which is the difference
 * between a folder structure and a pile of documents with parents.
 *
 * The walk is capped by the number of pages there are. A cycle cannot be made
 * through the interface — `plotMove` refuses a page dropped into its own
 * subtree — but it can arrive over sync from a client that was offline while
 * somebody else reparented the other half, and a breadcrumb that hangs the tab
 * is a worse bug than a breadcrumb that stops early.
 */
export function useTrail(pageId: string): Page[] {
  const { workspaceId } = useSession();
  const pages = useQuery(() => linkable(workspaceId), [workspaceId]);
  return useMemo(() => {
    const byId = new Map(pages.map((page) => [page.id, page]));
    const trail: Page[] = [];
    const seen = new Set<string>([pageId]);
    let at = byId.get(pageId)?.parent_id ?? null;
    while (at && !seen.has(at)) {
      const parent = byId.get(at);
      if (!parent) break;
      seen.add(at);
      trail.unshift(parent);
      at = parent.parent_id ?? null;
    }
    return trail;
  }, [pages, pageId]);
}

/**
 * The titles somebody has linked to and nobody has written, with how often.
 *
 * A wiki's to-do list, and the one it keeps without being asked: every time an
 * author writes `[[Expenses policy]]` before the policy exists, they have said
 * what is missing. Sorted by how many pages want it, because that is the order
 * worth writing them in.
 */
export function useUnwritten(): { title: string; from: Page[] }[] {
  const { workspaceId } = useSession();
  const pages = useQuery(() => linkable(workspaceId), [workspaceId]);
  return useMemo(() => {
    const graph = linkGraph(pages);
    const byId = new Map(pages.map((page) => [page.id, page]));
    // The key is folded for grouping, so the title shown is the one an author
    // actually typed rather than a lowercased version of it.
    const written = new Map<string, string>();
    for (const page of pages) {
      for (const link of wikiLinks(page.content ?? '')) {
        if (!written.has(pageKey(link.target))) written.set(pageKey(link.target), link.target.trim());
      }
    }
    return [...graph.missing]
      .map(([key, ids]) => ({
        title: written.get(key) ?? key,
        from: ids.map((id) => byId.get(id)).filter((page): page is Page => !!page && !page.archived),
      }))
      .filter((entry) => entry.from.length > 0)
      .sort((a, b) => b.from.length - a.from.length || a.title.localeCompare(b.title));
  }, [pages]);
}

/** What a rename did to the rest of the wiki. */
export interface Renamed {
  /** How many other pages had a link rewritten. */
  pages: number;
  /** The new title cannot be written inside `[[…]]`, so the links were left alone. */
  refused: boolean;
}

/**
 * Rename a page and keep the links to it pointing at it.
 *
 * A wiki where renaming a page breaks every link to it is a wiki where people
 * stop renaming pages, and then stop linking to them. So the rename carries the
 * links with it: every other page whose `[[Old title]]` resolved here is
 * rewritten to the new one, and the alias somebody wrote about this page —
 * `[[Old title|how we start]]` — is kept, because those were their words about
 * the page and not a copy of its name.
 *
 * Two things it deliberately does not do.
 *
 * It does not touch the page being renamed. Its body is a CRDT under an open
 * editor, and writing `content` at it would replace that CRDT from text —
 * which is the documented reading of a content-only write, and exactly the
 * wrong one while somebody is typing into it. A page linking to itself by name
 * is rare enough to be worth that.
 *
 * And it does not ask first. Every page it rewrites keeps its previous revision
 * in the page history, so the undo already exists; a dialog in front of a
 * correct default is a dialog people learn to dismiss. The caller says how many
 * pages moved.
 */
export function useRenamePage(): (page: Page, title: string) => Renamed {
  const { workspaceId } = useSession();
  return (page: Page, title: string) => {
    const next = title.trim();
    update('page', page.id, { title: next });
    const was = String(page.title ?? '').trim();
    if (!was || !next || pageKey(was) === pageKey(next)) return { pages: 0, refused: false };
    if (!linkableTitle(next)) return { pages: 0, refused: true };

    let changed = 0;
    for (const other of linkable(workspaceId)) {
      if (other.id === page.id) continue;
      const rewritten = renameLinks(other.content ?? '', was, next);
      if (rewritten === null || rewritten === other.content) continue;
      update('page', other.id, { content: rewritten });
      changed += 1;
    }
    return { pages: changed, refused: false };
  };
}
