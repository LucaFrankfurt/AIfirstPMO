/**
 * The environments a workspace runs in, and who may open each.
 *
 * A sheet on the vault rather than a screen in settings, because this is
 * configuration you reach for *while* filing a credential — "this is the
 * staging one, and there is no staging yet" — and a trip through settings and
 * back is where that thought gets abandoned.
 *
 * Two things are worth reading here rather than in the code.
 *
 * **The floor is the sharp control on this sheet.** Lowering `production` from
 * admin to member opens every credential in it, to everybody, at once. So the
 * sheet is an administrator's, the server refuses the write regardless of what
 * the interface shows, and the row says how many secrets a change would be
 * about.
 *
 * **Deleting is refused in front of the person rather than behind them.** The
 * server refuses it too — that is where it counts — but the browser already
 * holds every label, so it can say "production still holds four" while the
 * pointer is over the button, instead of writing optimistically and undoing it
 * a second later with a message in the corner.
 */
import { useState } from 'react';
import { ENVIRONMENT_ROLES, byEnvironmentOrder, type EnvironmentRole, type EnvironmentRow } from '@kolibri/shared';

import { create, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useSession } from '../../kernel/identity/session';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select } from '../../kernel/design-system/ui/field';
import { Icon, Sheet, useToast } from '../../kernel/design-system/ui';

const ROLE_KEY: Record<EnvironmentRole, TranslationKey> = {
  member: 'environment.roleMember',
  admin: 'environment.roleAdmin',
  owner: 'environment.roleOwner',
};

/**
 * The same folding the server does, applied while somebody types.
 *
 * Written twice, and the copy is deliberate rather than an oversight: the
 * server's is the one that decides, and this one is only so that the field
 * does not accept `Staging EU` and hand back `staging-eu` a beat later as
 * though it had been corrected. If they ever disagree the server wins, which
 * is the safe way round.
 */
const fold = (raw: string): string =>
  raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').slice(0, 40);

export function EnvironmentsSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { workspaceId, role } = useSession();
  const mayEdit = role === 'owner' || role === 'admin';

  const environments = useQuery(
    () => list('environment', (row) => row.workspace_id === workspaceId)
      .sort(byEnvironmentOrder),
    [workspaceId],
  );
  const secrets = useQuery(() => list('secret', (row) => row.workspace_id === workspaceId), [workspaceId]);
  const held = (id: string) => secrets.filter((row) => row.environment_id === id).length;

  const [adding, setAdding] = useState('');

  const add = () => {
    const name = fold(adding);
    if (!name) return;
    if (environments.some((one) => one.name === name)) {
      toast(t('environment.exists', { name }));
      return;
    }
    create('environment', { workspace_id: workspaceId, name, min_role: 'member' });
    setAdding('');
  };

  const rename = (one: EnvironmentRow, raw: string) => {
    const name = fold(raw);
    if (!name || name === one.name) return;
    if (environments.some((other) => other.id !== one.id && other.name === name)) {
      toast(t('environment.exists', { name }));
      return;
    }
    update('environment', one.id, { name });
  };

  const drop = (one: EnvironmentRow) => {
    const count = held(one.id);
    if (count) {
      toast(t('environment.stillHolds', { name: one.name, count }));
      return;
    }
    remove('environment', one.id);
  };

  return (
    <Sheet
      title={t('environment.title')}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>{t('action.done')}</Button>}
    >
      <p className="secret-notice">
        <Icon name="shield" size={15} />
        <span>{t('environment.explain')}</span>
      </p>

      {environments.map((one) => (
        <div className="secret-row" key={one.id}>
          <div className="flex items-center gap-2">
            <Input
              defaultValue={one.name}
              disabled={!mayEdit}
              aria-label={t('environment.name')}
              onBlur={(event) => rename(one, event.target.value)}
            />
            <Select
              value={one.min_role ?? 'member'}
              disabled={!mayEdit}
              aria-label={t('environment.minRole')}
              onChange={(event) => update('environment', one.id, { min_role: event.target.value })}
            >
              {ENVIRONMENT_ROLES.map((rank) => <option key={rank} value={rank}>{t(ROLE_KEY[rank])}</option>)}
            </Select>
            {mayEdit && (
              <Button size="sm" variant="ghost" aria-label={t('action.delete')} onClick={() => drop(one)}>
                <Icon name="trash" size={14} />
              </Button>
            )}
          </div>
          <span className="secret-meta">
            {/* Zero is its own sentence rather than "0 secrets": the plural
                machinery here is `_one`/`_other` through Intl.PluralRules,
                which has no zero category in English or German. */}
            {held(one.id) ? t('environment.holds', { count: held(one.id) }) : t('environment.holdsNone')}
          </span>
        </div>
      ))}

      {mayEdit && (
        <div className="secret-row">
          <div className="flex items-center gap-2">
            <Input
              value={adding}
              placeholder={t('environment.addPlaceholder')}
              aria-label={t('environment.add')}
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') add(); }}
            />
            <Button size="sm" disabled={!fold(adding)} onClick={add}>{t('environment.add')}</Button>
          </div>
        </div>
      )}

      {!mayEdit && <p className="text-[12px] text-muted">{t('environment.adminOnly')}</p>}
    </Sheet>
  );
}
