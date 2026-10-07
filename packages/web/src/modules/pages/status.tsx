/**
 * How finished a page is, on screen.
 *
 * The arithmetic is in `@kolibri/shared` (`statusOf`, `kindOf`, `ladder`)
 * because the server defaults a new page with the same functions; this file is
 * the one place that *draws* a rung, and everything that shows one goes through
 * it — the page itself, the tree, the cards, the tidy screen, the bulk bar,
 * and the notice a page carries when it leaves the workspace.
 *
 * One chip, not six. A status that looked slightly different in each of those
 * places would be six things to learn rather than one, and the colour is the
 * workspace's own: nothing here picks a colour, it only renders the one
 * somebody chose.
 *
 * **The names are data.** `kind` is the only thing any of this branches on, so
 * a workspace that renames "Im Review" to "Gegenlesen" keeps its tidy finding
 * and its export notice. That is the whole reason the kind exists.
 */
import {
  kindOf, ladder, orderKey, PAGE_STATUS_KINDS, statusOf,
  type Page, type PageStatus, type PageStatusKind,
} from '@kolibri/shared';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { list, useQuery } from '../../kernel/sync/store';
import { create, remove, update } from '../../kernel/sync/mutations';
import { Icon, useConfirm, type MenuItem } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { useCanWrite, useSession } from '../../kernel/identity/session';
import { Chip, chipDot } from '../../kernel/design-system/ui/chip';

/** What each kind is called where a workspace is choosing one. */
export const KIND_KEY: Record<PageStatusKind, TranslationKey> = {
  draft: 'pageStatus.draft', review: 'pageStatus.review', final: 'pageStatus.final',
};

/** This workspace's ladder, in its own order. */
export function usePageStatuses(): PageStatus[] {
  const { workspaceId } = useSession();
  return useQuery(
    () => ladder(list('pageStatus', (row) => row.workspace_id === workspaceId) as PageStatus[]),
    [workspaceId],
  );
}

/**
 * The rung, as a dot and a word.
 *
 * `dot` leaves the word out, which is what a tree row and a card need: at that
 * size the colour is the whole message and the title is what somebody is
 * reading. Both carry the name as a `title`, so the colour is never the *only*
 * way to know — a chip that says something only in colour says nothing to a
 * reader who cannot tell these two greens apart.
 */
export function PageStatusChip({ page, dot }: { page: Pick<Page, 'status_id'>; dot?: boolean }) {
  const statuses = usePageStatuses();
  const status = statusOf(page, statuses);
  if (!status) return null;
  if (dot) {
    return <span className={chipDot} style={{ background: status.color }} title={status.name} aria-label={status.name} />;
  }
  return (
    <Chip title={status.name}>
      <span className={chipDot} style={{ background: status.color }} />
      {status.name}
    </Chip>
  );
}

/**
 * The line a page carries when it leaves the workspace.
 *
 * Anything that is not `final` says so on a share link, an export and a print,
 * because those are the three ways a half-written page becomes somebody else's
 * evidence. It reads the kind rather than the name for the reason this whole
 * file does, and it renders nothing at all for a finished page: a document that
 * announces its own correctness is noise.
 */
export function PageStatusNotice({ page }: { page: Pick<Page, 'status_id'> }) {
  const t = useT();
  const statuses = usePageStatuses();
  const status = statusOf(page, statuses);
  if (!status || kindOf(page, statuses) === 'final') return null;
  return (
    <p className="status-notice" style={{ borderColor: status.color }}>
      {t('page.statusNotFinal', { status: status.name })}
    </p>
  );
}

/**
 * The rungs, as menu entries that set one.
 *
 * The same shape `labelItems` has beside it, with one difference that is not
 * cosmetic: a label is a set and a status is a choice, so these do not toggle.
 * Picking the rung a page is already on is a no-op rather than a way to end up
 * with no status at all — "none" is what a workspace with an empty ladder
 * means, not something anybody should reach by clicking twice.
 */
export function statusItems(page: Page, statuses: PageStatus[], section: string): MenuItem[] {
  const current = statusOf(page, statuses);
  return statuses.map((status) => ({
    id: `status-${status.id}`,
    section,
    label: status.name,
    icon: <span className={chipDot} style={{ background: status.color }} />,
    hint: current?.id === status.id ? '✓' : undefined,
    onSelect: () => {
      if (page.status_id === status.id) return;
      update('page', page.id, { status_id: status.id });
    },
  }));
}

/**
 * The ladder, where a workspace decides what its rungs are called.
 *
 * In the workspace tab rather than a tab of its own: three rows of settings do
 * not earn a place in a strip that is already ten wide and scrolls on a phone.
 *
 * The same editor shape a project's workflow states have, deliberately — colour
 * on the left, name in the middle, order and delete on the right, and the
 * meaning on its own row underneath. Two lists that answer the same kind of
 * question should not be two different controls to learn.
 *
 * **Deleting a rung does not touch the pages on it.** They fall back to the
 * draft through `statusOf`, which is what the confirmation says. The
 * alternative — walking the wiki to rewrite every page — is a destructive
 * operation hiding inside a settings screen.
 */
export function PageStatusSettings() {
  const t = useT();
  const { workspaceId } = useSession();
  const statuses = usePageStatuses();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  if (!canWrite) return null;

  return (
    <>
      <div className="flex items-center gap-2" style={{ margin: '18px 0 8px' }}>
        <SectionHeading tight>{t('page.statuses')}</SectionHeading>
      </div>
      <p className="mt-0 mb-2.5 text-[12.5px] text-muted">{t('page.statusesHint')}</p>

      {statuses.map((status, at) => (
        <div className="stack-card" key={status.id}>
          <div className="flex items-center gap-2">
            <input
              type="color" value={status.color} style={{ width: 28, height: 28, border: 'none', background: 'none' }}
              aria-label={t('page.statusColour')}
              onChange={(event) => update('pageStatus', status.id, { color: event.target.value })}
            />
            <Input
              className="flex-1 min-w-0" value={status.name} aria-label={t('page.status')}
              onChange={(event) => update('pageStatus', status.id, { name: event.target.value })}
            />
            {/* The same fractional keys the pages themselves are ordered by,
                applied one level up — see `orderKey`. */}
            <Button
              variant="ghost" size="icon" aria-label={t('state.moveUp')} disabled={at === 0}
              onClick={() => update('pageStatus', status.id, {
                sort_order: orderKey(statuses[at - 2]?.sort_order ?? null, statuses[at - 1]?.sort_order ?? null),
              })}
            >
              <Icon name="chevronUp" size={14} />
            </Button>
            <Button
              variant="ghost" size="icon" aria-label={t('state.moveDown')} disabled={at === statuses.length - 1}
              onClick={() => update('pageStatus', status.id, {
                sort_order: orderKey(statuses[at + 1]?.sort_order ?? null, statuses[at + 2]?.sort_order ?? null),
              })}
            >
              <Icon name="chevronDown" size={14} />
            </Button>
            <Button
              variant="ghost" size="icon" aria-label={t('page.statusDelete')}
              onClick={async () => {
                if (await confirm(t('page.statusDeleteConfirm', { name: status.name }))) {
                  remove('pageStatus', status.id);
                }
              }}
            >
              <Icon name="trash" size={14} />
            </Button>
          </div>
          <div className="field-row mt-2">
            <div className="field">
              <label htmlFor={`ps-kind-${status.id}`}>{t('page.statusKind')}</label>
              <Select
                id={`ps-kind-${status.id}`} value={status.kind}
                onChange={(event) => update('pageStatus', status.id, { kind: event.target.value })}
              >
                {PAGE_STATUS_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{t(KIND_KEY[kind])}</option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      ))}

      <Button
        variant="secondary" size="sm" className="mt-2"
        onClick={() => create('pageStatus', {
          workspace_id: workspaceId,
          name: t('pageStatus.draft'),
          kind: 'draft',
          color: '#94a3b8',
          sort_order: orderKey(statuses[statuses.length - 1]?.sort_order ?? null, null),
        })}
      >
        <Icon name="plus" size={14} /> {t('page.statusAdd')}
      </Button>
      {dialog}
    </>
  );
}
