/**
 * The vault: what the team keeps, who it is for, and when it was last changed.
 *
 * The screen is a list of *labels*. No value is ever on it, in the DOM or in
 * the store, until somebody asks for one — and then it is a request, an audit
 * row and a countdown, not a field that happens to be filled in. That shape is
 * the whole feature: a secret manager is not encryption with a list in front of
 * it, it is the discipline that reading a credential is an act.
 *
 * Which means the two things this screen owes a reader are the ones a page full
 * of pasted keys cannot give them: **who else can read this**, said on every
 * row rather than in a settings sheet, and **how old is it**, said loudly enough
 * that the contractor's database password from two years ago is the row your eye
 * lands on.
 *
 * What it must not do is imply more than is true. The line at the top says what
 * the sealing buys and what it does not, because a vault that quietly lets
 * people believe the operator cannot read it is worse than a page — a page at
 * least looks like what it is.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  SECRET_ACCESS, SECRET_KINDS, daysUntilRotation, rotation, strength,
  type Secret, type SecretAccess, type SecretKind, type Strength,
} from '@kolibri/shared';

import { Header } from '../../../kernel/design-system/chrome';
import { api } from '../../../kernel/sync/api';
import { remove, update } from '../../../kernel/sync/mutations';
import { pull } from '../../../kernel/sync/sync';
import { byId, list, useQuery } from '../../../kernel/sync/store';
import { relativeTime } from '../../../kernel/design-system/format';
import { useCanWrite, useMemberMap, useSession } from '../../../kernel/identity/session';
import { useT, type TranslationKey } from '../../../kernel/i18n/i18n';
import { Button } from '../../../kernel/design-system/ui/button';
import { Input, Select, Textarea } from '../../../kernel/design-system/ui/field';
import { Empty, Icon, MenuButton, Sheet, useConfirm, useToast } from '../../../kernel/design-system/ui';

/** One word per kind, and one glyph, so a list of twenty is scannable. */
const KIND_KEY: Record<SecretKind, TranslationKey> = {
  password: 'secret.kindPassword',
  api_key: 'secret.kindApiKey',
  token: 'secret.kindToken',
  certificate: 'secret.kindCertificate',
  connection: 'secret.kindConnection',
  note: 'secret.kindNote',
};

const ACCESS_KEY: Record<SecretAccess, TranslationKey> = {
  workspace: 'secret.accessWorkspace',
  project: 'secret.accessProject',
  private: 'secret.accessPrivate',
};

/*
 * Written out rather than built from the value, three times over.
 *
 * `t(\`secret.accessHint.${access}\`)` needs a cast to compile, which is the
 * type checker being told to stop helping; and a `className` assembled the same
 * way is invisible to `check:css`, which exists because a class nothing defines
 * fails silently in every browser. Both are the same mistake — a name computed
 * at runtime is a name no tool can check — and both cost three lines to avoid.
 */
const ACCESS_HINT: Record<SecretAccess, TranslationKey> = {
  workspace: 'secret.accessHint.workspace',
  project: 'secret.accessHint.project',
  private: 'secret.accessHint.private',
};

const STRENGTH_KEY: Record<Strength, TranslationKey> = {
  weak: 'secret.strength.weak',
  fair: 'secret.strength.fair',
  strong: 'secret.strength.strong',
};

const STRENGTH_CLASS: Record<Strength, string> = {
  weak: 'secret-strength-weak',
  fair: 'secret-strength-fair',
  strong: 'secret-strength-strong',
};

/** How long a revealed value stays on screen. */
const SHOW_MS = 45_000;

/* ------------------------------------------------------------------ reveal */

/**
 * A value, on screen, briefly.
 *
 * The countdown is not security theatre and it is not security either — anybody
 * looking at the screen has already read it. It is for the case that actually
 * happens: a tab left open on a shared machine, or a screen share started two
 * minutes after somebody copied a key. Making it disappear on its own is the
 * difference between a habit that works and a habit that depends on remembering.
 *
 * Held in component state and nowhere else. It is never written to the store,
 * never to IndexedDB, and it goes when the row collapses.
 */
function Revealed({ value, onDone }: { value: string; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [left, setLeft] = useState(Math.round(SHOW_MS / 1000));

  useEffect(() => {
    const tick = setInterval(() => setLeft((was) => was - 1), 1000);
    const end = setTimeout(onDone, SHOW_MS);
    return () => {
      clearInterval(tick);
      clearTimeout(end);
    };
  }, [onDone]);

  return (
    <div className="secret-value">
      {/* A textarea rather than a `<code>`: a connection string wraps, a
          certificate is forty lines, and both have to be selectable by hand for
          the browser that will not give us the clipboard. */}
      <Textarea readOnly value={value} rows={value.length > 90 ? 4 : 1} onFocus={(event) => event.currentTarget.select()} />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            toast(t('secret.copied'));
          }}
        >
          <Icon name="copy" size={14} /> {t('action.copy')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>{t('secret.hide')}</Button>
        <span className="flex-1 min-w-0" />
        <span className="text-[12px] text-muted">{t('secret.hidesIn', { count: Math.max(left, 0) })}</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- form */

/** Creating one, or editing what a row says about itself. */
function SecretSheet({ secret, onClose }: { secret: Secret | null; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { workspaceId } = useSession();
  const projects = useQuery(() => list('project', (project) => !project.archived), []);

  const [name, setName] = useState(secret?.name ?? '');
  const [description, setDescription] = useState(secret?.description ?? '');
  const [kind, setKind] = useState<SecretKind>(secret?.kind ?? 'password');
  const [access, setAccess] = useState<SecretAccess>(secret?.access ?? 'workspace');
  const [projectId, setProjectId] = useState(secret?.project_id ?? '');
  const [days, setDays] = useState(String(secret?.rotate_after_days ?? 0));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');

  const scored = value ? strength(value) : null;

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setFailed('');
    try {
      const patch = {
        name: name.trim(),
        description: description.trim() || null,
        kind,
        access,
        project_id: access === 'project' ? (projectId || null) : (projectId || null),
        rotate_after_days: Math.max(0, Number(days) || 0),
      };
      if (secret) {
        // Editing the label is an ordinary optimistic write: it syncs and
        // merges like anything else, and works with no network.
        update('secret', secret.id, patch);
        if (value) await api.secretValue(secret.id, value);
      } else {
        // Creating is not, and cannot be: the value has to be sealed with a key
        // this browser does not have. One request, then a pull so the row is
        // on screen rather than waiting for the next sync tick.
        await api.createSecret(workspaceId, { ...patch, value });
        await pull();
      }
      toast(secret ? t('secret.saved') : t('secret.created'));
      onClose();
    } catch (error) {
      // A failed value write on a *new* secret leaves a row with no value, and
      // the list says so rather than pretending. Better than rolling back a row
      // somebody may already have seen sync in.
      setFailed(error instanceof Error ? error.message : t('secret.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={secret ? t('secret.edit') : t('secret.new')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={!name.trim() || busy || (!secret && !value)} onClick={() => void save()}>
            {secret ? t('action.save') : t('secret.create')}
          </Button>
        </>
      }
    >
      <label className="field-row">
        <span>{t('secret.name')}</span>
        <Input value={name} autoFocus placeholder={t('secret.namePlaceholder')} onChange={(event) => setName(event.target.value)} />
      </label>

      <label className="field-row">
        <span>{t('secret.value')}</span>
        <Textarea
          value={value}
          rows={2}
          spellCheck={false}
          autoComplete="off"
          placeholder={secret ? t('secret.valueKeep') : t('secret.valuePlaceholder')}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {/* Said only while somebody is typing a value they chose. An API key is
          whatever the provider made it, and calling that "weak" would be noise
          about a thing nobody here can change. */}
      {scored && kind === 'password' && (
        <p className={`text-[12px] ${STRENGTH_CLASS[scored]}`}>{t(STRENGTH_KEY[scored])}</p>
      )}

      <label className="field-row">
        <span>{t('secret.kind')}</span>
        <Select value={kind} onChange={(event) => setKind(event.target.value as SecretKind)}>
          {SECRET_KINDS.map((one) => <option key={one} value={one}>{t(KIND_KEY[one])}</option>)}
        </Select>
      </label>

      <label className="field-row">
        <span>{t('secret.access')}</span>
        <Select
          value={access}
          onChange={(event) => setAccess(event.target.value as SecretAccess)}
        >
          {SECRET_ACCESS.map((one) => <option key={one} value={one}>{t(ACCESS_KEY[one])}</option>)}
        </Select>
      </label>
      <p className="text-[12px] text-muted mb-2">{t(ACCESS_HINT[access])}</p>

      {access === 'project' && (
        <label className="field-row">
          <span>{t('secret.project')}</span>
          <Select value={projectId ?? ''} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">{t('secret.pickProject')}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </label>
      )}

      <label className="field-row">
        <span>{t('secret.rotateEvery')}</span>
        <Input type="number" min={0} max={3650} value={days} onChange={(event) => setDays(event.target.value)} />
      </label>
      <p className="text-[12px] text-muted mb-2">{t('secret.rotateHint')}</p>

      <label className="field-row">
        <span>{t('secret.description')}</span>
        <Textarea value={description ?? ''} rows={2} placeholder={t('secret.descriptionPlaceholder')} onChange={(event) => setDescription(event.target.value)} />
      </label>

      {failed && <p className="text-[12.5px] text-danger">{failed}</p>}
    </Sheet>
  );
}

/* -------------------------------------------------------------------- list */

export function SecretsIndex() {
  const t = useT();
  const toast = useToast();
  const members = useMemberMap();
  const canWrite = useCanWrite();
  const { workspaceId } = useSession();
  const { confirm, dialog } = useConfirm();

  const secrets = useQuery(
    () => list('secret', (row) => row.workspace_id === workspaceId && !row.archived)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    [workspaceId],
  );

  const [scope, setScope] = useState<'all' | SecretAccess>('all');
  const [editing, setEditing] = useState<Secret | null>(null);
  const [creating, setCreating] = useState(false);
  /** The one row currently showing its value, and the value. Never more than one. */
  const [open, setOpen] = useState<{ id: string; value: string } | null>(null);
  const [opening, setOpening] = useState('');

  const shown = useMemo(() => (scope === 'all' ? secrets : secrets.filter((row) => row.access === scope)), [secrets, scope]);
  const stale = useMemo(() => secrets.filter((row) => rotation(row) === 'overdue').length, [secrets]);

  const reveal = async (secret: Secret) => {
    if (open?.id === secret.id) {
      setOpen(null);
      return;
    }
    setOpening(secret.id);
    try {
      setOpen({ id: secret.id, value: (await api.revealSecret(secret.id)).value });
    } catch (error) {
      toast(error instanceof Error ? error.message : t('secret.revealFailed'));
    } finally {
      setOpening('');
    }
  };

  return (
    <>
      <Header title={t('secret.title')}>
        {canWrite && (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> <span className="hide-sm">{t('secret.new')}</span>
          </Button>
        )}
      </Header>

      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        {/* The honest line, first and once. Anybody deciding whether to move
            their keys in here deserves to read what it does before they see how
            nice the list looks. */}
        <p className="secret-notice">
          <Icon name="shield" size={15} />
          <span>{t('secret.promise')}</span>
        </p>

        {secrets.length > 0 && (
          <div className="flex items-center flex-wrap gap-2 mb-3.5">
            {(['all', ...SECRET_ACCESS] as const).map((one) => (
              <Button
                key={one} size="sm" variant={scope === one ? 'primary' : 'secondary'}
                aria-pressed={scope === one}
                onClick={() => setScope(one)}
              >
                {one === 'all' ? t('secret.scopeAll') : t(ACCESS_KEY[one])}
              </Button>
            ))}
            <span className="flex-1 min-w-0" />
            {stale > 0 && <span className="secret-flag overdue">{t('secret.overdueCount', { count: stale })}</span>}
          </div>
        )}

        {!secrets.length ? (
          <Empty
            emoji="🔐" title={t('secret.emptyTitle')} hint={t('secret.emptyHint')}
            action={canWrite ? <Button variant="primary" onClick={() => setCreating(true)}>{t('secret.new')}</Button> : undefined}
          />
        ) : (
          shown.map((secret) => {
            const due = rotation(secret);
            const days = daysUntilRotation(secret);
            const author = members.get(secret.created_by);
            const project = secret.project_id ? byId('project', secret.project_id) : null;
            return (
              <div className="secret-row" key={secret.id}>
                <div className="flex items-center gap-2">
                  <span aria-hidden="true">🔑</span>
                  <span className="flex-1 min-w-0">
                    <strong className="truncate">{secret.name}</strong>
                    <span className="secret-meta">
                      {t(KIND_KEY[secret.kind] ?? 'secret.kindPassword')}
                      {' · '}
                      {secret.access === 'project' && project ? project.name : t(ACCESS_KEY[secret.access] ?? 'secret.accessWorkspace')}
                      {secret.rotated_at ? ` · ${t('secret.rotatedAgo', { time: relativeTime(secret.rotated_at) })}` : ` · ${t('secret.neverSet')}`}
                      {secret.last_used_at ? ` · ${t('secret.usedAgo', { time: relativeTime(secret.last_used_at) })}` : ''}
                      {author ? ` · ${t('secret.byAuthor', { name: author.name })}` : ''}
                    </span>
                  </span>
                  {due === 'overdue' && <span className="secret-flag overdue">{t('secret.overdue')}</span>}
                  {due === 'due' && <span className="secret-flag due">{t('secret.dueIn', { count: Math.max(days ?? 0, 0) })}</span>}
                  <Button size="sm" disabled={opening === secret.id} onClick={() => void reveal(secret)}>
                    {open?.id === secret.id ? t('secret.hide') : t('secret.reveal')}
                  </Button>
                  {canWrite && (
                    <MenuButton
                      variant="ghost" size="iconSm" label={t('common.moreActions')}
                      items={[
                        { id: 'edit', label: t('secret.edit'), icon: <Icon name="pencil" size={14} />, onSelect: () => setEditing(secret) },
                        { id: 'history', label: t('secret.history'), icon: <Icon name="refresh" size={14} />, onSelect: () => { void showHistory(secret); } },
                        {
                          id: 'delete', section: t('module.danger'), label: t('secret.delete'), danger: true,
                          onSelect: async () => {
                            if (await confirm(t('secret.deleteConfirm', { name: secret.name }))) remove('secret', secret.id);
                          },
                        },
                      ]}
                    >
                      <Icon name="dots" size={15} />
                    </MenuButton>
                  )}
                </div>
                {secret.description && <p className="secret-description">{secret.description}</p>}
                {open?.id === secret.id && <Revealed value={open.value} onDone={() => setOpen(null)} />}
              </div>
            );
          })
        )}
      </div>

      {(creating || editing) && (
        <SecretSheet secret={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}
      {dialog}
    </>
  );

  /**
   * Who has read this one, in a toast rather than a screen.
   *
   * A deliberate smallness: the question is asked rarely and answered in one
   * line — "Ada, Lin and one other, last on Tuesday" — and a whole sheet for it
   * would be a sheet nobody opens twice. The full record is in the workspace
   * audit log, which is where an admin already looks.
   */
  async function showHistory(secret: Secret): Promise<void> {
    try {
      const { entries } = await api.secretHistory(secret.id);
      const readers = [...new Set(entries.filter((one) => one.verb === 'revealed').map((one) => one.actor_name).filter(Boolean))];
      if (!readers.length) {
        toast(t('secret.neverRead'));
        return;
      }
      toast(t('secret.readBy', { names: readers.slice(0, 3).join(', '), time: relativeTime(entries[0].created_at) }));
    } catch {
      toast(t('secret.revealFailed'));
    }
  }
}

