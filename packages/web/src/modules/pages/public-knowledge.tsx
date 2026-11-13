/**
 * The mark a page carries when it is written for people outside the workspace.
 *
 * Shown where the page is read, in the tree, and above the editor, because the
 * person the mark is for is the next one to type into the page: a sentence
 * written for colleagues on a page a support assistant reads is a sentence a
 * visitor is told. Which widgets read it is said beside it, read from the
 * widgets this person can see.
 */
import type { Page } from '@kolibri/shared';
import { Icon } from '../../kernel/design-system/ui';
import { Chip } from '../../kernel/design-system/ui/chip';
import { useT } from '../../kernel/i18n/i18n';
import { list, useQuery } from '../../kernel/sync/store';

type Marked = Pick<Page, 'id' | 'public_knowledge'>;

/** Read defensively: a page synced before the column existed has none. */
export const isPublicKnowledge = (page: Partial<Marked>): boolean => Number(page.public_knowledge) === 1;

/** The widgets whose assistant names this page, by name. */
function useReaders(pageId: string): string[] {
  return useQuery(
    () => list('widget', (widget) => Array.isArray(widget.knowledge) && widget.knowledge.includes(pageId))
      .map((widget) => widget.name),
    [pageId],
  );
}

/** Beside the status and the labels, where the things somebody sets already live. */
export function PublicKnowledgeChip({ page }: { page: Marked }) {
  const t = useT();
  const readers = useReaders(page.id);
  if (!isPublicKnowledge(page)) return null;
  return (
    <Chip title={t('page.publicKnowledgeHint')}>
      <Icon name="globe" size={12} />
      {t('page.publicKnowledge')}
      {readers.length > 0 && <span className="text-muted">· {readers.join(', ')}</span>}
    </Chip>
  );
}

/** In a tree row: the globe alone, named for a screen reader. */
export function PublicKnowledgeMark({ page }: { page: Marked }) {
  const t = useT();
  if (!isPublicKnowledge(page)) return null;
  return (
    <span role="img" className="text-muted inline-flex" title={t('page.publicKnowledge')} aria-label={t('page.publicKnowledge')}>
      <Icon name="globe" size={12} />
    </span>
  );
}

/** Above the editor, while somebody is writing into it. */
export function PublicKnowledgeNotice({ page }: { page: Marked }) {
  const t = useT();
  if (!isPublicKnowledge(page)) return null;
  return (
    <p className="m-0 mb-2 flex items-center gap-1.5 text-[12px] text-muted">
      <Icon name="globe" size={13} />
      {t('page.publicKnowledgeEditing')}
    </p>
  );
}
