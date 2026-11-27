/**
 * The public knowledge base: the pages written for people outside the
 * workspace, gathered on one screen.
 *
 * A view, not a place. The articles stay wherever they sit in the wiki — under
 * a product, beside the handbook — and a page joins or leaves this list by its
 * mark (`public_knowledge`), set from its own menu. So there is nothing here to
 * move or keep in step: it is the same rows, filtered, with the path to each
 * one beside it so a reader can see where an article lives.
 *
 * A replaced article is listed faint rather than left out: the support
 * assistant already skips it, and this is the screen where somebody notices
 * it is still marked and takes the mark off.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isSuperseded, matchesTerms, parseTerms, type Page } from '@kolibri/shared';
import { Header, Trail } from '../../../kernel/design-system/chrome';
import { useT } from '../../../kernel/i18n/i18n';
import { cn } from '../../../kernel/design-system/cn';
import { relativeTime } from '../../../kernel/design-system/format';
import { createPage } from '../../../kernel/sync/mutations';
import { list, useQuery } from '../../../kernel/sync/store';
import { useCanWrite, useMe, useSession } from '../../../kernel/identity/session';
import { Button } from '../../../kernel/design-system/ui/button';
import { Input } from '../../../kernel/design-system/ui/field';
import { navItem } from '../../../kernel/design-system/ui/nav';
import { Empty, Icon } from '../../../kernel/design-system/ui';
import { useMinute } from '../../../kernel/design-system/minute';
import { trailsOf } from '../page-tree';
import { isPublicKnowledge } from '../public-knowledge';
import { PageStatusChip, usePageStatuses } from '../status';

export function PagesKnowledge() {
  useMinute(); // re-reads the ages below once a minute — `design-system/minute.ts`
  const t = useT();
  const navigate = useNavigate();
  const me = useMe();
  const { workspaceId } = useSession();
  const canWrite = useCanWrite();
  const statuses = usePageStatuses();
  const [query, setQuery] = useState('');

  // The whole wiki, for the paths: an article's parent need not be an article.
  const wiki = useQuery(
    () => list('page', (page) => page.workspace_id === workspaceId && !page.archived && !page.is_template) as Page[],
    [workspaceId],
  );
  const trails = useMemo(() => trailsOf(wiki), [wiki]);
  const articles = useMemo(() => {
    const terms = parseTerms(query);
    return wiki
      .filter((page) => isPublicKnowledge(page) && (!terms.length || matchesTerms(page.title || '', terms)))
      .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }, [wiki, query]);
  const marked = useMemo(() => wiki.some(isPublicKnowledge), [wiki]);

  const write = () => navigate(`/pages/${createPage({ title: t('common.untitled'), public_knowledge: 1 }, me)}`);

  return (
    <>
      <Header title={t('page.publicKnowledge')}>
        <Button variant="secondary" size="sm" onClick={() => navigate('/pages')}>
          <Icon name="page" size={14} /> <span className="hide-sm">{t('page.listTitle')}</span>
        </Button>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={write}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('page.knowledgeNew')}</span>
          </Button>
        )}
      </Header>
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <Trail parts={[{ to: '/pages', label: t('page.listTitle'), icon: <Icon name="page" size={13} /> }]} />
        <p className="text-muted text-body" style={{ marginTop: 0 }}>{t('page.knowledgeIntro')}</p>
        {!marked ? (
          <Empty
            emoji="🌐" title={t('page.knowledgeEmpty')} hint={t('page.knowledgeEmptyHint')}
            action={canWrite ? <Button variant="primary" onClick={write}>{t('page.knowledgeNew')}</Button> : undefined}
          />
        ) : (
          <>
            <Input
              className="mb-3" style={{ maxWidth: 280 }}
              placeholder={t('page.filterTree')} aria-label={t('page.filterTree')}
              value={query} onChange={(event) => setQuery(event.target.value)}
            />
            {!articles.length && <p className="text-muted text-label">{t('page.filterNone')}</p>}
            {articles.map((page) => {
              const replaced = isSuperseded(page, statuses);
              const trail = trails.get(page.id) ?? [];
              return (
                <Link key={page.id} to={`/pages/${page.id}`} className="page-row" style={replaced ? { opacity: 0.55 } : undefined}>
                  <span className={cn(navItem(), 'page-row-main')}>
                    <span style={{ width: 16 }}>{page.icon ?? '📄'}</span>
                    <span className="flex-1 min-w-0 truncate" style={replaced ? { textDecoration: 'line-through' } : undefined}>
                      {page.title || t('common.untitled')}
                    </span>
                    {replaced && <span className="sr-only">{t('page.replacedMark')}</span>}
                    {trail.length > 0 && (
                      <span className="tidy-where hide-sm">{trail.map((parent) => parent.title || t('common.untitled')).join(' › ')}</span>
                    )}
                    <PageStatusChip page={page} dot />
                    <span className="text-caption text-muted hide-sm">{t('page.updated', { time: relativeTime(page.updated_at) })}</span>
                  </span>
                </Link>
              );
            })}
          </>
        )}
      </div>
    </>
  );
}
