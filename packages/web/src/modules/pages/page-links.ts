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
  headingSlug, linkContext, linkGraph, linkableTitle, pageKey, pageResolver, renameLinks, wikiLinks,
  type Page,
} from '@kolibri/shared';
import { list, useQuery } from '../../kernel/sync/store';
import type { GraphEdge, GraphNode } from './pagegraph';
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
 * The prefix every heading id on a page carries.
 *
 * One constant because three things have to agree about it — the renderer
 * writing the ids, the link resolver writing the fragments, and the outline
 * writing its own links — and a prefix that two of them share is a set of
 * anchors that work from one direction only.
 */
export const HEADING_PREFIX = 'h-';

/** The fragment a link to a section spells, or nothing for a link to a page. */
export const sectionHash = (heading: string | null): string =>
  (heading ? `#${encodeURIComponent(HEADING_PREFIX + headingSlug(heading))}` : '');

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
 *
 * `[[#Somewhere]]` names a section of the page it is written on and resolves to
 * a bare fragment. That one is never "missing": a section this page does not
 * have is a typo, and offering to *create a page* called Somewhere would be a
 * strange answer to it.
 */
export function usePageHref(): (target: string, heading: string | null) => { href: string; missing?: boolean } | undefined {
  const { workspaceId } = useSession();
  const canWrite = useCanWrite();
  const pages = useQuery(() => linkable(workspaceId), [workspaceId]);
  return useMemo(() => {
    const resolve = pageResolver(pages);
    return (target: string, heading: string | null) => {
      const hash = sectionHash(heading);
      if (!target) return hash ? { href: hash } : undefined;
      const found = resolve(target);
      if (found) return { href: `/pages/${found.id}${hash}` };
      return canWrite ? { href: `/pages/new?title=${encodeURIComponent(target.trim())}`, missing: true } : undefined;
    };
  }, [pages, canWrite]);
}

/**
 * What `![[…]]` draws, for a reader who may see it.
 *
 * The same cache and the same resolution as a link, handing over the text as
 * well as the address — so the visibility rule is still the one the store
 * applied when it synced, and this file has no second opinion about it.
 *
 * An archived page is deliberately still embeddable. It resolves as a link, and
 * a document that quietly lost a section because somebody tidied up elsewhere
 * would be the worse surprise of the two.
 */
export function usePageBody(): (target: string) => { id: string; title: string; href: string; content: string } | undefined {
  const { workspaceId } = useSession();
  const pages = useQuery(() => linkable(workspaceId), [workspaceId]);
  return useMemo(() => {
    const resolve = pageResolver(pages);
    return (target: string) => {
      const found = resolve(target);
      return found
        ? { id: found.id, title: found.title || target, href: `/pages/${found.id}`, content: found.content ?? '' }
        : undefined;
    };
  }, [pages]);
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

/** What a rename will do to the rest of the wiki. */
export interface Renamed {
  /** How many other pages have a link that follows it. */
  pages: number;
  /** The new title cannot be written inside `[[…]]`, so the links stay where they are. */
  refused: boolean;
}

/**
 * Rename a page, and say what that does to the links pointing at it.
 *
 * The rewriting itself is **not** here: it is an invariant of the write path,
 * so it holds for MCP and for a `PATCH` typed into curl as much as for this
 * screen — see `followRename` in the server's page rules. Doing it here as
 * well would not be belt and braces but a bug: two independent CRDT edits
 * deleting the same span and inserting the same words merge into the words
 * twice.
 *
 * What is left here is the sentence somebody needs to hear. It is a prediction
 * rather than a report — counted against the pages this client holds, before
 * the server has done anything — and it is the same count for the same reason
 * the resolver is: every page a person may read is already in the cache.
 *
 * The cost of the split is honest and small: rename a page with no connection
 * and the links to it read as unwritten on this device until the rewrite comes
 * back down the sync. Nothing is lost, and the alternative was the interface
 * quietly replacing a colleague's paragraph with its own copy of it.
 */
export function useRenamePage(): (page: Page, title: string) => Renamed {
  const { workspaceId } = useSession();
  return (page: Page, title: string) => {
    const next = title.trim();
    update('page', page.id, { title: next });
    const was = String(page.title ?? '').trim();
    if (!was || !next || pageKey(was) === pageKey(next)) return { pages: 0, refused: false };
    if (!linkableTitle(next)) return { pages: 0, refused: true };

    const following = linkable(workspaceId).filter((other) => {
      if (other.id === page.id) return false;
      const rewritten = renameLinks(other.content ?? '', was, next);
      return rewritten !== null && rewritten !== other.content;
    });
    return { pages: following.length, refused: false };
  };
}

/**
 * The wiki as a picture: what is joined to what, and what is missing.
 *
 * Only pages a link touches. A wiki's graph with every page in it is mostly
 * dots — the tree above already lists those, and drawing them again as
 * unconnected specks says nothing except that the screen is busy. What is left
 * is the part the picture is *for*: the clusters, the page everything hangs
 * off, and the titles nobody has written yet, which are the holes.
 */
export function usePageGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { workspaceId } = useSession();
  const pages = useQuery(() => linkable(workspaceId), [workspaceId]);
  return useMemo(() => {
    const live = pages.filter((page) => !page.archived);
    const graph = linkGraph(live);
    const byId = new Map(live.map((page) => [page.id, page]));
    // The spelling an author actually typed, kept against the folded key the
    // graph groups by — a node labelled `kündigung` is the index talking, not
    // anything anybody wrote.
    const written = new Map<string, string>();
    for (const page of live) {
      for (const link of wikiLinks(page.content ?? '')) {
        if (link.target && !written.has(pageKey(link.target))) written.set(pageKey(link.target), link.target.trim());
      }
    }
    const edges: GraphEdge[] = [];
    const touched = new Set<string>();

    for (const [from, targets] of graph.out) {
      for (const to of targets) {
        edges.push({ from, to });
        touched.add(from);
        touched.add(to);
      }
    }
    // An unwritten title is one node however many pages want it, which is what
    // makes it look like the hole it is rather than like several.
    for (const [key, from] of graph.missing) {
      const wanted = from.filter((id) => byId.has(id));
      if (!wanted.length) continue;
      const id = `?${key}`;
      for (const one of wanted) {
        edges.push({ from: one, to: id });
        touched.add(one);
      }
      touched.add(id);
    }

    const nodes: GraphNode[] = [...touched].map((id) => {
      const page = byId.get(id);
      return page
        ? { id, label: page.title || id, kind: 'page' as const }
        : { id, label: written.get(id.slice(1)) ?? id.slice(1), kind: 'unwritten' as const };
    });
    return { nodes, edges };
  }, [pages]);
}
