/**
 * Share links: read-only URLs for people who are not in the workspace.
 *
 * The link is rendered by the server as a plain document, so this component
 * only ever deals with the row that authorises it — making one, showing the
 * URL, and turning it off. The token comes back with the row on the next sync,
 * which is why creating a link takes a moment before there is one to copy.
 */
import { useEffect, useState } from 'react';
import type { Share, ShareKind } from '@kolibri/shared';
import { useT } from '../lib/i18n';
import { list, useQuery } from '../lib/store';
import { create, remove, update } from '../lib/mutations';
import { pull } from '../lib/sync';
import { useSession } from '../session';
import { Button } from '../components/ui/button';
import { Icon, Sheet, useConfirm, useToast } from './ui';

export const shareUrl = (share: Share): string =>
  share.token ? `${location.origin}/s/${share.token}` : '';

/** What this share points at, as an object the row can be matched against. */
export interface ShareTarget {
  kind: ShareKind;
  page_id?: string | null;
  view_id?: string | null;
  project_id?: string | null;
  name: string;
}

export function useSharesFor(target: ShareTarget): Share[] {
  return useQuery(
    () => list('share', (share) => (target.kind === 'page'
      ? share.page_id === target.page_id
      // An intake link belongs to a project rather than to a view, so it is
      // matched on the project alone; a task share also has to agree about
      // which saved view it points at.
      : target.kind === 'intake'
        ? share.kind === 'intake' && share.project_id === (target.project_id ?? null)
        : share.kind === 'tasks' && share.view_id === (target.view_id ?? null) && share.project_id === (target.project_id ?? null))),
    [target.kind, target.page_id, target.view_id, target.project_id],
  );
}

export function ShareSheet({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { role } = useSession();
  const { confirm, dialog } = useConfirm();
  const shares = useSharesFor(target);
  const [busy, setBusy] = useState(false);

  // The token is minted by the server, so a freshly made link is blank until
  // the next pull brings it back. One pull, rather than a spinner that lies.
  useEffect(() => {
    if (shares.some((share) => !share.token)) void pull();
  }, [shares]);

  async function makeLink(): Promise<void> {
    setBusy(true);
    create('share', {
      kind: target.kind,
      page_id: target.page_id ?? null,
      view_id: target.view_id ?? null,
      project_id: target.project_id ?? null,
      name: target.name,
      expires_at: null,
      include_done: 1,
      allow_comments: 0,
    });
    await pull();
    setBusy(false);
  }

  const canShare = role === 'owner' || role === 'admin' || role === 'member';

  return (
    <Sheet title={t(target.kind === 'intake' ? 'intake.linkTitle' : 'share.title')} onClose={onClose}>
      <p className="text-[12px] text-muted" style={{ marginBottom: 12 }}>{t(target.kind === 'intake' ? 'intake.linkHint' : 'share.hint')}</p>

      {shares.length === 0 && (
        <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>{t('share.none')}</p>
      )}

      {shares.map((share) => (
        <div className="stack-card" key={share.id}>
          <div className="flex items-center gap-2" style={{ gap: 8 }}>
            <input
              className="input flex-1 min-w-0" readOnly value={shareUrl(share) || t('share.minting')}
              aria-label={t('share.link')}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm" disabled={!share.token}
              onClick={() => {
                void navigator.clipboard?.writeText(shareUrl(share));
                toast(t('common.copied'));
              }}
            >
              <Icon name="copy" size={13} /> {t('action.copy')}
            </Button>
            <Button variant="ghost" size="iconSm" aria-label={t('share.revoke')} title={t('share.revoke')}
              onClick={async () => {
                if (await confirm(t('share.revokeConfirm'))) remove('share', share.id);
              }}
            >
              <Icon name="trash" size={13} />
            </Button>
          </div>

          <div className="flex items-center gap-2 flex-wrap" style={{ gap: 12, marginTop: 8, fontSize: 12.5 }}>
            <label className="flex items-center gap-2" style={{ gap: 6 }}>
              <span className="text-muted">{t('share.expires')}</span>
              <input
                className="input" type="date" style={{ width: 150 }}
                value={share.expires_at ? new Date(share.expires_at).toISOString().slice(0, 10) : ''}
                onChange={(event) => update('share', share.id, {
                  expires_at: event.target.value ? Date.parse(`${event.target.value}T23:59:59Z`) : null,
                })}
              />
            </label>
            {target.kind === 'tasks' && (
              <label className="flex items-center gap-2" style={{ gap: 6 }}>
                <input
                  type="checkbox" checked={!!share.include_done}
                  onChange={(event) => update('share', share.id, { include_done: event.target.checked ? 1 : 0 })}
                />
                {t('share.includeDone')}
              </label>
            )}
            {/* Off until somebody says otherwise: an unauthenticated write is a
                thing you opt into, not a default that arrives with a link. */}
            {target.kind === 'page' && (
              <label className="flex items-center gap-2" style={{ gap: 6 }} title={t('share.allowCommentsHint')}>
                <input
                  type="checkbox" checked={!!share.allow_comments}
                  onChange={(event) => update('share', share.id, { allow_comments: event.target.checked ? 1 : 0 })}
                />
                {t('share.allowComments')}
              </label>
            )}
            <span className="text-muted">{t('share.opened', { count: share.views ?? 0 })}</span>
          </div>
        </div>
      ))}

      {canShare && (
        <Button variant="primary" block onClick={makeLink} disabled={busy} style={{ marginTop: 10 }}>
          <Icon name="link" size={14} /> {busy ? t('share.making') : t('share.make')}
        </Button>
      )}
      {dialog}
    </Sheet>
  );
}
