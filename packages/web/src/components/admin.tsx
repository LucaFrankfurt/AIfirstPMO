/**
 * The two screens an administrator asks for: what happened here, and what this
 * instance calls out to.
 */
import { useEffect, useState } from 'react';
import type { Webhook } from '@kolibri/shared';
import { api } from '../lib/api';
import { relativeTime, shortDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { create, remove, update } from '../lib/mutations';
import { list, useQuery } from '../lib/store';
import { useSession } from '../session';
import { Avatar, Empty, Icon, useConfirm, useToast } from './ui';
import { useMemberMap } from '../session';

/* ------------------------------------------------------------ audit log */

export function AuditLog() {
  const t = useT();
  const { workspaceId } = useSession();
  const members = useMemberMap();
  const [entries, setEntries] = useState<any[]>([]);
  const [oldest, setOldest] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  const load = async (before?: number) => {
    const page = await api.audit(workspaceId, before);
    setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
    setOldest(page.oldest);
    if (page.entries.length === 0) setDone(true);
  };
  useEffect(() => { void load(); }, [workspaceId]);

  if (!entries.length) {
    return (
      <>
        <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('audit.title')}</h3>
        <p className="hint">{t('audit.empty')}</p>
      </>
    );
  }

  return (
    <>
      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('audit.title')}</h3>
      <p className="hint" style={{ marginBottom: 8 }}>{t('audit.hint')}</p>
      <div className="card" style={{ padding: 0 }}>
        {entries.map((entry) => (
          <div className="row trash-row" key={entry.id} style={{ gap: 9 }}>
            <Avatar user={members.get(entry.actor_id)} size={18} />
            <span className="truncate" style={{ minWidth: 110 }}>{entry.actor_name ?? t('common.someone')}</span>
            <span className="grow truncate">
              {entry.verb === 'created' ? t('audit.created')
                : entry.verb === 'deleted' ? t('audit.deleted')
                  : t('audit.updated', { field: entry.field ?? '' })}
              {' · '}
              {entry.task_identifier ? `${entry.task_identifier} ${entry.task_title ?? ''}` : entry.page_title ?? entry.project_name ?? ''}
            </span>
            <span className="muted hide-sm" style={{ fontSize: 12 }}>{shortDate(entry.created_at)}</span>
            <span className="muted" style={{ fontSize: 12 }}>{relativeTime(entry.created_at)}</span>
          </div>
        ))}
      </div>
      {!done && oldest && (
        <button className="btn sm" style={{ marginTop: 8 }} onClick={() => void load(oldest)}>{t('audit.more')}</button>
      )}
    </>
  );
}

/* ------------------------------------------------------------- webhooks */

const EVENTS = ['task.created', 'task.updated', 'task.completed', 'comment.created', 'page.updated'] as const;

export function Webhooks() {
  const t = useT();
  const toast = useToast();
  const { workspaceId } = useSession();
  const { confirm, dialog } = useConfirm();
  const outgoing = useQuery(
    () => list('webhook', (hook) => hook.workspace_id === workspaceId && hook.direction !== 'in'),
    [workspaceId],
  );
  const incoming = useQuery(
    () => list('webhook', (hook) => hook.workspace_id === workspaceId && hook.direction === 'in'),
    [workspaceId],
  );
  const hooks = outgoing;
  const [url, setUrl] = useState('');

  return (
    <>
      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('hooks.title')}</h3>
      <p className="hint" style={{ marginBottom: 8 }}>{t('hooks.hint')}</p>

      {hooks.map((hook) => <Hook key={hook.id} hook={hook} onRemove={async (id, name) => {
        if (await confirm(t('hooks.remove') + ` — ${name || hook.url}?`)) remove('webhook', id);
      }} />)}

      <form
        className="row"
        style={{ marginTop: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = url.trim();
          // Refused rather than stored: a webhook that can never fire is a
          // setting somebody will spend an afternoon on.
          if (!/^https?:\/\//i.test(trimmed)) {
            toast(t('hooks.url'));
            return;
          }
          create('webhook', {
            workspace_id: workspaceId, url: trimmed, name: '',
            events: 'task.created,task.completed', enabled: 1,
          });
          setUrl('');
        }}
      >
        <input
          className="input grow" type="url" placeholder="https://example.com/hooks/kolibri"
          aria-label={t('hooks.url')} value={url} onChange={(event) => setUrl(event.target.value)}
        />
        <button className="btn" type="submit"><Icon name="plus" size={14} /> {t('hooks.add')}</button>
      </form>

      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('hooks.inTitle')}</h3>
      <p className="hint" style={{ marginBottom: 8 }}>{t('hooks.inHint')}</p>
      {incoming.map((hook) => <Hook key={hook.id} hook={hook} onRemove={async (id, name) => {
        if (await confirm(t('hooks.remove') + ` — ${name}?`)) remove('webhook', id);
      }} />)}
      <button
        className="btn"
        onClick={() => create('webhook', {
          workspace_id: workspaceId, url: '', name: 'GitHub', events: '', enabled: 1, direction: 'in',
        })}
      >
        <Icon name="plus" size={14} /> {t('hooks.inAdd')}
      </button>
      {dialog}
    </>
  );
}

function Hook({ hook, onRemove }: { hook: Webhook; onRemove: (id: string, name: string) => void }) {
  const t = useT();
  const toast = useToast();
  const chosen = new Set(String(hook.events ?? '').split(',').map((name) => name.trim()));
  const inbound = hook.direction === 'in';
  const [secret, setSecret] = useState<{ secret: string; url: string | null } | null>(null);

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input grow" value={hook.name ?? ''} placeholder={t('hooks.name')} aria-label={t('hooks.name')}
          onChange={(event) => update('webhook', hook.id, { name: event.target.value })}
        />
        <label className="row" style={{ gap: 5, fontSize: 12.5 }}>
          <input
            type="checkbox" checked={!!hook.enabled}
            onChange={(event) => update('webhook', hook.id, { enabled: event.target.checked ? 1 : 0 })}
          />
          {t('hooks.enabled')}
        </label>
        <button className="btn ghost sm icon" aria-label={t('hooks.remove')} onClick={() => onRemove(hook.id, hook.name)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {inbound ? (
        <div className="row" style={{ gap: 8, margin: '6px 0' }}>
          <input
            className="input grow" readOnly value={secret?.url ?? t('hooks.inHidden')}
            aria-label={t('hooks.inUrl')} onFocus={(event) => event.currentTarget.select()}
          />
          <button
            className="btn sm"
            onClick={async () => {
              try {
                const found = await api.get<{ secret: string; url: string | null }>(`/api/webhooks/${hook.id}/secret`);
                setSecret(found);
                if (found.url) {
                  void navigator.clipboard?.writeText(found.url);
                  toast(t('common.copied'));
                }
              } catch {
                toast(t('hooks.inFailed'));
              }
            }}
          >
            <Icon name="link" size={13} /> {t('hooks.inReveal')}
          </button>
        </div>
      ) : (
        <div className="muted truncate" style={{ fontSize: 12, margin: '4px 0 6px' }}>{hook.url}</div>
      )}

      {!inbound && (
        <div className="row" style={{ gap: 8, marginBottom: 6 }}>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            <span className="muted">{t('hooks.format')}</span>
            <select
              className="select" style={{ width: 150 }} value={hook.format ?? 'kolibri'}
              onChange={(event) => update('webhook', hook.id, { format: event.target.value })}
            >
              <option value="kolibri">{t('hooks.formatKolibri')}</option>
              <option value="slack">Slack / Mattermost</option>
              <option value="discord">Discord</option>
            </select>
          </label>
        </div>
      )}

      <div className="row wrap" style={{ gap: 6, display: inbound ? 'none' : undefined }}>
        {EVENTS.map((event) => (
          <label key={event} className="chip button" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              style={{ marginInlineEnd: 5 }}
              checked={chosen.has(event)}
              onChange={(changed) => {
                const next = new Set(chosen);
                if (changed.target.checked) next.add(event);
                else next.delete(event);
                update('webhook', hook.id, { events: [...next].join(',') });
              }}
            />
            {event}
          </label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        {t('hooks.lastResult')}:{' '}
        {hook.last_sent_at
          ? `${hook.last_status ?? '—'} ${hook.last_error ? `· ${hook.last_error}` : ''} · ${relativeTime(hook.last_sent_at)}`
          : t('hooks.never')}
      </div>
    </div>
  );
}
