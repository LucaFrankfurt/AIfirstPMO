/**
 * The two screens an administrator asks for: what happened here, and what this
 * instance calls out to.
 */
import { useEffect, useState } from 'react';
import { WEBHOOK_EVENTS, type Webhook } from '@kolibri/shared';
import { api, ApiError } from '../lib/api';
import { relativeTime, shortDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { create, remove, update } from '../lib/mutations';
import { list, useQuery } from '../lib/store';
import { useSession } from '../session';
import { Avatar, Empty, Icon, useConfirm, useToast } from './ui';
import { Button } from '../components/ui/button';
import { Input, Select } from '../components/ui/field';
import { SectionHeading } from './ui/section';
import { chipVariants } from './ui/chip';
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
        <SectionHeading>{t('audit.title')}</SectionHeading>
        <p className="text-[12px] text-muted">{t('audit.empty')}</p>
      </>
    );
  }

  return (
    <>
      <SectionHeading>{t('audit.title')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('audit.hint')}</p>
      <div className="rounded-[var(--radius)] border border-line bg-raised p-0">
        {entries.map((entry) => (
          <div className="flex items-center gap-2 trash-row" key={entry.id} style={{ gap: 9 }}>
            <Avatar user={members.get(entry.actor_id)} size={18} />
            <span className="truncate" style={{ minWidth: 110 }}>{entry.actor_name ?? t('common.someone')}</span>
            <span className="flex-1 min-w-0 truncate">
              {entry.verb === 'created' ? t('audit.created')
                : entry.verb === 'deleted' ? t('audit.deleted')
                  : t('audit.updated', { field: entry.field ?? '' })}
              {' · '}
              {entry.task_identifier ? `${entry.task_identifier} ${entry.task_title ?? ''}` : entry.page_title ?? entry.project_name ?? ''}
            </span>
            <span className="text-muted hide-sm text-[12.5px]">{shortDate(entry.created_at)}</span>
            <span className="text-muted text-[12.5px]">{relativeTime(entry.created_at)}</span>
          </div>
        ))}
      </div>
      {!done && oldest && (
        <Button size="sm" className="mt-2" onClick={() => void load(oldest)}>{t('audit.more')}</Button>
      )}
    </>
  );
}

/* ------------------------------------------------------------- webhooks */


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
      <SectionHeading>{t('hooks.title')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('hooks.hint')}</p>

      {hooks.map((hook) => <Hook key={hook.id} hook={hook} onRemove={async (id, name) => {
        if (await confirm(t('hooks.remove') + ` — ${name || hook.url}?`)) remove('webhook', id);
      }} />)}

      <form
        className="flex items-center gap-2 mt-2"
       
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = url.trim();
          // Refused rather than stored: a webhook that can never fire is a
          // setting somebody will spend an afternoon on.
          if (!looksLikeUrl(trimmed)) {
            toast(t('hooks.urlInvalid'));
            return;
          }
          create('webhook', {
            workspace_id: workspaceId, url: trimmed, name: '',
            events: 'task.created,task.completed', enabled: 1,
          });
          setUrl('');
        }}
      >
        <Input
          className="flex-1 min-w-0" type="url" placeholder="https://example.com/hooks/kolibri"
          aria-label={t('hooks.url')} value={url} onChange={(event) => setUrl(event.target.value)}
        />
        <Button type="submit"><Icon name="plus" size={14} /> {t('hooks.add')}</Button>
      </form>

      <SectionHeading>{t('hooks.inTitle')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('hooks.inHint')}</p>
      {incoming.map((hook) => <Hook key={hook.id} hook={hook} onRemove={async (id, name) => {
        if (await confirm(t('hooks.remove') + ` — ${name}?`)) remove('webhook', id);
      }} />)}
      <Button
        onClick={() => create('webhook', {
          workspace_id: workspaceId, url: '', name: 'GitHub', events: '', enabled: 1, direction: 'in',
        })}
      >
        <Icon name="plus" size={14} /> {t('hooks.inAdd')}
      </Button>
      {dialog}
    </>
  );
}

/** The one rule about a hook URL, in the two places that write one. */
const looksLikeUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value.trim());

function Hook({ hook, onRemove }: { hook: Webhook; onRemove: (id: string, name: string) => void }) {
  const t = useT();
  const toast = useToast();
  const chosen = new Set(String(hook.events ?? '').split(',').map((name) => name.trim()));
  const inbound = hook.direction === 'in';
  const [secret, setSecret] = useState<{ secret: string; url: string | null } | null>(null);
  const [testing, setTesting] = useState(false);
  /*
   * The URL is edited as a draft and written when the field is left, unlike the
   * name beside it, which is written on every keystroke. A name typed halfway
   * is a name; a URL typed halfway is an address this server would try to call.
   */
  const [draft, setDraft] = useState(String(hook.url ?? ''));
  const commitUrl = (): void => {
    const next = draft.trim();
    if (next === String(hook.url ?? '')) return;
    if (!looksLikeUrl(next)) {
      toast(t('hooks.urlInvalid'));
      setDraft(String(hook.url ?? ''));
      return;
    }
    update('webhook', hook.id, { url: next });
  };

  return (
    <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5 mb-2">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1 min-w-0" value={hook.name ?? ''} placeholder={t('hooks.name')} aria-label={t('hooks.name')}
          onChange={(event) => update('webhook', hook.id, { name: event.target.value })}
        />
        <label className="flex items-center gap-[5px] text-[12.5px]">
          <input
            type="checkbox" checked={!!hook.enabled}
            onChange={(event) => update('webhook', hook.id, { enabled: event.target.checked ? 1 : 0 })}
          />
          {t('hooks.enabled')}
        </label>
        <Button variant="ghost" size="iconSm" aria-label={t('hooks.remove')} onClick={() => onRemove(hook.id, hook.name)}>
          <Icon name="trash" size={13} />
        </Button>
      </div>
      {inbound ? (
        <div className="flex items-center gap-2" style={{ margin: '6px 0' }}>
          <Input
            className="flex-1 min-w-0" readOnly value={secret?.url ?? t('hooks.inHidden')}
            aria-label={t('hooks.inUrl')} onFocus={(event) => event.currentTarget.select()}
          />
          <Button size="sm"
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
          </Button>
        </div>
      ) : (
        <>
          {/* Editable, because a URL is the field most likely to be wrong: an
              n8n test URL that should have been the production one, a host
              that moved, a typo. It used to be printed here as text, so the
              only way to change it was to delete the hook — which also threw
              away the signing secret the receiver had already been given. */}
          <div className="flex items-center gap-2" style={{ margin: '6px 0' }}>
            <Input
              className="flex-1 min-w-0" type="url" value={draft} aria-label={t('hooks.url')}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitUrl}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            />
            <Button
              size="sm" disabled={testing}
              onClick={async () => {
                setTesting(true);
                try {
                  const answer = await api.post<{ detail: string }>(`/api/webhooks/${hook.id}/test`, {});
                  toast(t('hooks.tested', { detail: answer.detail }));
                } catch (problem) {
                  // The far end's own sentence, which is the useful half: a
                  // refused address, a 404 after a redirect, nothing listening.
                  toast(problem instanceof ApiError && problem.message ? problem.message : t('hooks.testFailed'));
                } finally {
                  setTesting(false);
                }
              }}
            >
              <Icon name="send" size={13} /> {t('hooks.test')}
            </Button>
          </div>
          {/* The receiver checks the signature with this, so somebody setting a
              receiver up has to be able to read it. The reveal button was only
              ever offered for incoming hooks. */}
          <div className="flex items-center gap-2" style={{ margin: '0 0 6px' }}>
            <Input
              className="flex-1 min-w-0" readOnly value={secret?.secret ?? t('hooks.inHidden')}
              aria-label={t('hooks.secret')} onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm"
              onClick={async () => {
                try {
                  const found = await api.get<{ secret: string; url: string | null }>(`/api/webhooks/${hook.id}/secret`);
                  setSecret(found);
                  void navigator.clipboard?.writeText(found.secret);
                  toast(t('common.copied'));
                } catch {
                  toast(t('hooks.inFailed'));
                }
              }}
            >
              <Icon name="key" size={13} /> {t('hooks.inReveal')}
            </Button>
          </div>
        </>
      )}

      {!inbound && (
        <div className="flex items-center gap-2 mb-1.5">
          <label className="flex items-center gap-1.5 text-[12.5px]">
            <span className="text-muted">{t('hooks.format')}</span>
            <Select style={{ width: 150 }} value={hook.format ?? 'kolibri'}
              onChange={(event) => update('webhook', hook.id, { format: event.target.value })}
            >
              <option value="kolibri">{t('hooks.formatKolibri')}</option>
              <option value="slack">Slack / Mattermost</option>
              <option value="discord">Discord</option>
            </Select>
          </label>
        </div>
      )}

      <div className="flex items-center flex-wrap gap-1.5" style={{ display: inbound ? 'none' : undefined }}>
        {WEBHOOK_EVENTS.map((event) => (
          <label key={event} className={chipVariants({ interactive: true })}>
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
      <div className="text-muted text-[11.5px] mt-1.5">
        {t('hooks.lastResult')}:{' '}
        {hook.last_sent_at
          ? `${hook.last_status ?? '—'} ${hook.last_error ? `· ${hook.last_error}` : ''} · ${relativeTime(hook.last_sent_at)}`
          : t('hooks.never')}
      </div>
      {!inbound && <Deliveries hookId={hook.id} />}
    </div>
  );
}

interface Delivery {
  id: string;
  event: string;
  status: number | null;
  attempts: number;
  last_error: string | null;
  send_after: number;
  sent_at: number | null;
  failed_at: number | null;
  created_at: number;
}

/**
 * What this hook has called out, and what became of each one.
 *
 * Asked for rather than synced, and only when somebody opens it: this is the
 * screen for the half-hour after a receiver broke, not something to keep on
 * every device. A row that gave up is the one worth acting on, so it is the one
 * that gets the button.
 */
function Deliveries({ hookId }: { hookId: string }) {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Delivery[] | null>(null);

  const load = async () => {
    const answer = await api.get<{ deliveries: Delivery[] }>(`/api/webhooks/${hookId}/deliveries?limit=10`);
    setRows(answer.deliveries);
  };

  return (
    <div className="mt-1.5">
      <Button
        variant="ghost" size="sm"
        onClick={async () => {
          const next = !open;
          setOpen(next);
          if (next) await load().catch(() => setRows([]));
        }}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /> {t('hooks.deliveries')}
      </Button>
      {open && (
        <ul className="list-none p-0 m-0 mt-1">
          {rows?.length === 0 && <li className="text-muted text-[11.5px]">{t('hooks.deliveriesEmpty')}</li>}
          {(rows ?? []).map((row) => (
            <li key={row.id} className="flex items-center gap-2 text-[11.5px]" style={{ padding: '3px 0' }}>
              <span className="flex-1 min-w-0 truncate">{row.event}</span>
              <span className="text-muted whitespace-nowrap">
                {row.sent_at
                  ? `${row.status ?? '—'} · ${relativeTime(row.sent_at)}`
                  : row.failed_at
                    ? `${t('hooks.deliveriesGaveUp')} · ${t('hooks.attempts', { count: row.attempts })}`
                    : `${t('hooks.deliveriesWaiting')} · ${t('hooks.attempts', { count: row.attempts })}`}
              </span>
              <Button
                variant="ghost" size="sm"
                onClick={async () => {
                  try {
                    await api.post(`/api/webhooks/${hookId}/deliveries/${row.id}/replay`, {});
                    toast(t('hooks.replayed'));
                    // Long enough for the attempt to have happened, so the row
                    // that comes back says what became of it rather than what
                    // it looked like a moment before it was tried.
                    setTimeout(() => { void load().catch(() => undefined); }, 800);
                  } catch {
                    toast(t('hooks.replayFailed'));
                  }
                }}
              >
                {t('hooks.replay')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
