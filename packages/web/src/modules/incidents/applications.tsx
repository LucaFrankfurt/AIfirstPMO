/**
 * The list an incident's affected applications are chosen from.
 *
 * Kept by hand, short, and in the words the people affected use — "the shop",
 * "the VPN" — rather than the hostnames the infrastructure register knows them
 * by. Archiving rather than deleting is the button offered: an application that
 * was retired is still the one last year's incidents name, and a deleted one
 * turns those into incidents of nothing.
 */
import { useState } from 'react';
import { APPLICATION_CRITICALITY, isActive, orderKey, type ApplicationCriticality } from '@kolibri/shared';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select, checkRow } from '../../kernel/design-system/ui/field';
import { useT } from '../../kernel/i18n/i18n';
import { create, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useCanWrite } from '../../kernel/identity/session';
import { criticalityKey, useApplications, useIncidentPeople } from './incident-parts';

export function ApplicationsPanel() {
  const t = useT();
  const canWrite = useCanWrite();
  const apps = useApplications();
  const people = useIncidentPeople();
  const [name, setName] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const active = useQuery(() => list('incident', (row) => !row.deleted_at && isActive(row)), []);
  const shown = apps.filter((app) => showArchived || !app.archived);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body text-muted">{t('incident.applicationsIntro')}</p>
      {canWrite && (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const wanted = name.trim();
            if (!wanted) return;
            // Matched without case, as MCP matches: "crm" is the CRM.
            if (apps.some((app) => app.name.toLowerCase() === wanted.toLowerCase())) { setName(''); return; }
            create('application', {
              name: wanted,
              description: null,
              owner_id: null,
              criticality: 'medium',
              component_id: null,
              archived: 0,
              sort_order: orderKey(apps[apps.length - 1]?.sort_order ?? null, null),
            });
            setName('');
          }}
        >
          <Input
            inputSize="sm"
            className="flex-1"
            value={name}
            placeholder={t('incident.applicationPlaceholder')}
            aria-label={t('incident.addApplication')}
            onChange={(event) => setName(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={!name.trim()}>{t('action.add')}</Button>
        </form>
      )}
      {!shown.length ? (
        <Empty emoji="🧩" title={t('incident.applicationsEmpty')} />
      ) : (
        <ul className="flex list-none flex-col gap-1.5 p-0">
          {shown.map((app) => {
            const open = active.filter((row) => (row.applications ?? []).includes(app.id)).length;
            return (
              /* One row from `sm` up — name, criticality, owner, what is
                 burning, the button — and stacked below it, where four
                 controls side by side would squeeze the name to nothing. */
              <li key={app.id} className="incident-card grid items-center gap-2 p-2.5 sm:grid-cols-[minmax(0,1fr)_170px_190px_72px_auto]">
                <Input
                  inputSize="sm"
                  value={app.name}
                  disabled={!canWrite}
                  aria-label={t('incident.applicationName')}
                  onChange={(event) => update('application', app.id, { name: event.target.value })}
                />
                <Select
                  inputSize="sm"
                  value={app.criticality}
                  disabled={!canWrite}
                  aria-label={t('incident.criticality')}
                  onChange={(event) => update('application', app.id, { criticality: event.target.value as ApplicationCriticality })}
                >
                  {APPLICATION_CRITICALITY.map((one) => <option key={one} value={one}>{t(criticalityKey(one))}</option>)}
                </Select>
                <Select
                  inputSize="sm"
                  value={app.owner_id ?? ''}
                  disabled={!canWrite}
                  aria-label={t('incident.owner')}
                  onChange={(event) => update('application', app.id, { owner_id: event.target.value || null })}
                >
                  <option value="">{t('incident.noOwner')}</option>
                  {people.map((user) => <option key={user.id} value={user.id}>{user.name ?? user.email}</option>)}
                </Select>
                <span className="text-label text-danger">{open > 0 ? t('incident.activeCount', { count: open }) : ''}</span>
                {canWrite && (
                  <Button size="sm" onClick={() => update('application', app.id, { archived: app.archived ? 0 : 1 })}>
                    {app.archived ? t('action.unarchive') : t('action.archive')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {apps.some((app) => app.archived) && (
        <label className={checkRow}>
          <span className="select-box"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /></span>
          <span><span>{t('incident.showArchived')}</span></span>
        </label>
      )}
    </div>
  );
}
