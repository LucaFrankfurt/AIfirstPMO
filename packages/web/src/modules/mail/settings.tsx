/**
 * Connecting a mailbox, and deciding who may read it.
 *
 * The screen behind the feature. Everything else about mail happens over MCP or
 * in the search box; this is where somebody types a host, a login and a
 * password once, and then says whether `admin@` is for the whole company or for
 * two people.
 *
 * Three things are shaped by what the server will and will not accept, and it
 * is worth saying why here rather than leaving them as quirks of the form:
 *
 * **The password is not a field on the row.** It goes to its own endpoint,
 * because `password` is a `secret` in the entity registry and the sync path
 * would refuse it — which is the point: a credential that cannot be written
 * through the ordinary write path cannot be read back through the ordinary read
 * path either. So the form shows "set" or "not set" and a box to replace it,
 * and never the characters.
 *
 * **Test is a real connection.** Somebody who mistypes a host should find out
 * now, not in five minutes when a row quietly says "failing". The button signs
 * in and hangs up, and shows the provider's own words when it cannot — "AUTHENTICATIONFAILED"
 * and "application password required" send you to two different places.
 *
 * **Disconnecting deletes the messages.** Said on the button rather than in the
 * documentation, because it is the one place in this product where switching
 * something off throws data away, and the reason it does is that "we
 * disconnected that inbox" has to be able to mean it.
 */
import { useEffect, useState } from 'react';
import type { Mailbox, MailboxAccessLevel } from '@kolibri/shared';
import { Icon, useConfirm, useToast } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { Chip } from '../../kernel/design-system/ui/chip';
import { api } from '../../kernel/sync/api';
import { relativeTime } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { create, remove, update } from '../../kernel/sync/mutations';
import { useMembers, useSession } from '../../kernel/identity/session';

/** What the API adds to a synced row: whether a credential is stored. */
type MailboxRow = Mailbox & { has_password?: boolean };

export function MailboxSettings() {
  const t = useT();
  const toast = useToast();
  const { workspaceId } = useSession();
  const { confirm, dialog } = useConfirm();
  const mailboxes = useQuery(() => list('mailbox', (box) => box.workspace_id === workspaceId), [workspaceId]);
  const [address, setAddress] = useState('');
  /**
   * Which mailboxes have a password, asked of the API rather than of the mirror.
   *
   * It cannot come down the sync feed — that is the whole point of a `secret`
   * field — so this is one request, refreshed when a password is set. Missing,
   * every row reads as "no password", which is the safe direction: it prompts
   * for one that is already there rather than claiming one that is not.
   */
  const [withPassword, setWithPassword] = useState<Set<string>>(new Set());
  const refreshCredentials = async () => {
    try {
      const answer = await api.get<{ mailboxes: MailboxRow[] }>(`/api/workspaces/${workspaceId}/mailboxes`);
      setWithPassword(new Set(answer.mailboxes.filter((box) => box.has_password).map((box) => box.id)));
    } catch {
      /* offline: every row shows as needing a password, which is recoverable */
    }
  };
  useEffect(() => { void refreshCredentials(); }, [workspaceId]);

  return (
    <>
      <SectionHeading>{t('mailbox.title')}</SectionHeading>
      <p className="text-[12px] text-muted mb-2">{t('mailbox.hint')}</p>

      {mailboxes.map((box) => (
        <MailboxRowEditor
          key={box.id}
          mailbox={box as MailboxRow}
          hasPassword={withPassword.has(box.id)}
          onPasswordSet={refreshCredentials}
          onRemove={async () => {
            if (await confirm(t('mailbox.disconnectConfirm', { address: box.address }))) {
              remove('mailbox', box.id);
            }
          }}
        />
      ))}

      <form
        className="flex items-center gap-2 mt-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = address.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
            toast(t('mailbox.addressInvalid'));
            return;
          }
          // Guessed from the address, because `imap.` in front of the domain is
          // right for most providers and wrong in a way that is obvious on the
          // Test button rather than three days later.
          create('mailbox', {
            workspace_id: workspaceId,
            address: trimmed,
            name: '',
            host: `imap.${trimmed.split('@')[1] ?? ''}`,
            port: 993,
            encryption: 'tls',
            username: trimmed,
            access: 'workspace',
            members: [],
            enabled: 1,
            sync_days: 365,
          });
          setAddress('');
        }}
      >
        <Input
          className="flex-1 min-w-0" type="email" placeholder="support@example.com"
          aria-label={t('mailbox.address')} value={address} onChange={(event) => setAddress(event.target.value)}
        />
        <Button type="submit"><Icon name="plus" size={14} /> {t('mailbox.add')}</Button>
      </form>
      {dialog}
    </>
  );
}

function MailboxRowEditor({ mailbox, hasPassword, onPasswordSet, onRemove }: {
  mailbox: MailboxRow;
  hasPassword: boolean;
  onPasswordSet: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { workspaceId } = useSession();
  const members = useMembers();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const patch = (fields: Partial<Mailbox>) => update('mailbox', mailbox.id, fields as Record<string, unknown>);
  const named = new Set(mailbox.members ?? []);

  const run = async (what: 'test' | 'sync') => {
    setBusy(true);
    try {
      const answer = await api.post<{ ok?: boolean; error?: string; fetched?: number }>(
        `/api/workspaces/${workspaceId}/mailboxes/${mailbox.id}/${what}`, {},
      );
      // The server's own sentence when there is one. A "could not connect"
      // written here would be the same string for a wrong password, a wrong
      // host and a firewall, which are three different afternoons.
      if (answer.error) toast(answer.error);
      else if (what === 'sync') toast(t('mailbox.synced', { count: answer.fetched ?? 0 }));
      else toast(t('mailbox.testOk'));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[var(--radius)] border border-line bg-raised p-2 mb-2">
      <div className="flex items-center gap-2">
        <button className="flex-1 min-w-0 text-left" onClick={() => setOpen(!open)}>
          <div className="truncate">{mailbox.name || mailbox.address}</div>
          <div className="text-[12px] text-muted truncate">
            {mailbox.host}:{mailbox.port} · {t(`mailbox.access${mailbox.access === 'members' ? 'Members' : 'Workspace'}`)}
            {mailbox.message_count ? ` · ${t('mailbox.messages', { count: mailbox.message_count })}` : ''}
          </div>
        </button>
        <MailboxStatus mailbox={mailbox} hasPassword={hasPassword} />
        <Button onClick={() => setOpen(!open)}>{t(open ? 'action.done' : 'action.edit')}</Button>
      </div>

      {open && (
        <div className="flex flex-col gap-2 mt-2">
          <Input
            aria-label={t('mailbox.name')} placeholder={t('mailbox.name')}
            value={mailbox.name ?? ''} onChange={(event) => patch({ name: event.target.value })}
          />
          <div className="flex items-center gap-2">
            <Input
              className="flex-1 min-w-0" aria-label={t('mailbox.host')} placeholder="imap.example.com"
              value={mailbox.host ?? ''} onChange={(event) => patch({ host: event.target.value })}
            />
            <Input
              type="number" aria-label={t('mailbox.port')} style={{ width: 90 }}
              value={String(mailbox.port ?? 993)} onChange={(event) => patch({ port: Number(event.target.value) })}
            />
            <Select
              aria-label={t('mailbox.encryption')}
              value={mailbox.encryption ?? 'tls'}
              onChange={(event) => patch({ encryption: event.target.value as Mailbox['encryption'] })}
            >
              <option value="tls">TLS (993)</option>
              <option value="starttls">STARTTLS (143)</option>
              <option value="none">{t('mailbox.encryptionNone')}</option>
            </Select>
          </div>
          <Input
            aria-label={t('mailbox.username')} placeholder={mailbox.address}
            value={mailbox.username ?? ''} onChange={(event) => patch({ username: event.target.value })}
          />

          <div className="flex items-center gap-2">
            <Input
              className="flex-1 min-w-0" type="password" autoComplete="new-password"
              aria-label={t('mailbox.password')}
              placeholder={hasPassword ? t('mailbox.passwordSet') : t('mailbox.passwordUnset')}
              value={password} onChange={(event) => setPassword(event.target.value)}
            />
            <Button
              disabled={!password || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.post(`/api/workspaces/${workspaceId}/mailboxes/${mailbox.id}/password`, { password });
                  setPassword('');
                  onPasswordSet();
                  toast(t('mailbox.passwordStored'));
                } catch (error) {
                  toast(error instanceof Error ? error.message : String(error));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('action.save')}
            </Button>
          </div>

          {/* How far back the first pass reaches. Nothing else here changes what
              is *already* stored — lowering it does not delete anything, and
              raising it makes the next poll go back further. */}
          <label className="flex items-center gap-2 text-[12px] text-muted">
            {t('mailbox.syncDays')}
            <Input
              type="number" style={{ width: 100 }} aria-label={t('mailbox.syncDays')}
              value={String(mailbox.sync_days ?? 365)}
              onChange={(event) => patch({ sync_days: Number(event.target.value) })}
            />
          </label>

          <Select
            aria-label={t('mailbox.access')}
            value={mailbox.access ?? 'workspace'}
            onChange={(event) => {
              const next = event.target.value as MailboxAccessLevel;
              // Switching to restricted with nobody named would be refused by
              // the server, so the person doing the switching is put on the
              // list. They can take themselves off afterwards — which is two
              // deliberate steps rather than one absent-minded one.
              patch(next === 'members' && !named.size
                ? { access: next, members: [String(mailbox.created_by ?? '')].filter(Boolean) }
                : { access: next });
            }}
          >
            <option value="workspace">{t('mailbox.accessWorkspace')}</option>
            <option value="members">{t('mailbox.accessMembers')}</option>
          </Select>

          {mailbox.access === 'members' && (
            <div className="flex flex-wrap gap-1">
              {members.map((member) => (
                <button
                  key={member.id}
                  onClick={() => patch({
                    members: named.has(member.id)
                      ? (mailbox.members ?? []).filter((id) => id !== member.id)
                      : [...(mailbox.members ?? []), member.id],
                  })}
                >
                  <Chip tone={named.has(member.id) ? 'on' : 'default'} interactive>{member.name}</Chip>
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button disabled={busy || !hasPassword} onClick={() => run('test')}>{t('mailbox.test')}</Button>
            <Button disabled={busy || !hasPassword} onClick={() => run('sync')}>{t('mailbox.syncNow')}</Button>
            <Button variant="ghost" onClick={onRemove}>{t('mailbox.disconnect')}</Button>
          </div>
          <p className="text-[12px] text-muted">{t('mailbox.disconnectHint')}</p>
        </div>
      )}
    </div>
  );
}

/** The one-glance answer: is this mailbox actually working. */
function MailboxStatus({ mailbox, hasPassword }: { mailbox: MailboxRow; hasPassword: boolean }) {
  const t = useT();
  if (!hasPassword) return <Chip>{t('mailbox.passwordUnset')}</Chip>;
  if (mailbox.last_status === 'failing') {
    // The error itself as the title, so hovering answers "why" without
    // opening the row. It is the provider's sentence and worth keeping whole.
    return <Chip className="text-danger" title={mailbox.last_error ?? ''}>{t('mailbox.failing')}</Chip>;
  }
  if (!mailbox.last_sync_at) return <Chip>{t('mailbox.never')}</Chip>;
  return <Chip>{relativeTime(mailbox.last_sync_at)}</Chip>;
}

/** Whether this account can see any mailbox at all — for hiding the search screen. */
export const useMailboxes = (): MailboxRow[] => {
  const { workspaceId } = useSession();
  return useQuery(
    () => list('mailbox', (box) => box.workspace_id === workspaceId && !!box.enabled),
    [workspaceId],
  ) as MailboxRow[];
};

/** One mailbox from the mirror, for a result row that needs its name. */
export const mailboxName = (id: string): string => {
  const row = byId('mailbox', id);
  return row?.name || row?.address || '';
};
