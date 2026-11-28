/**
 * An incident's timeline: what was said, and what moved, in the order it
 * happened.
 *
 * Two kinds of line, and they are drawn differently on purpose. A person's
 * line — an update for whoever is waiting, a working note among the people
 * fixing it — is prose with a name on it. A change line is the server's record
 * that the status, priority or manager moved; it is small and grey, because it
 * is the skeleton the prose hangs on rather than something anybody said, and
 * it is written in the reader's language because it is stored as a field and
 * two values rather than as a sentence.
 *
 * The composer can move the status in the same breath as saying why, which is
 * the shape of every status-page update ever written: "Monitoring — the fix is
 * deployed, we are watching the error rate". And it can backdate a line, so a
 * timeline can be put together afterwards from the chat log.
 */
import { useMemo, useState } from 'react';
import {
  INCIDENT_STATUS, byOccurrence, isIncidentPriority, isIncidentStatus,
  type Incident, type IncidentStatus, type IncidentUpdate,
} from '@kolibri/shared';
import { Avatar } from '../../kernel/design-system/ui/avatar';
import { Icon } from '../../kernel/design-system/ui/icon';
import { useConfirm } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Label, Select, Textarea } from '../../kernel/design-system/ui/field';
import { exactTime } from '../../kernel/design-system/format';
import { useT } from '../../kernel/i18n/i18n';
import { create, remove, update } from '../../kernel/sync/mutations';
import { byId, list, useQuery } from '../../kernel/sync/store';
import { useCanWrite, useMe } from '../../kernel/identity/session';
import { now } from '../../kernel/sync/clock';
import { asLocalInput, priorityKey, statusKey } from './incident-parts';

/** Every line on one incident, oldest first. */
export function useTimeline(incidentId: string): IncidentUpdate[] {
  return useQuery(
    () => list('incidentUpdate', (row) => row.incident_id === incidentId && !row.deleted_at).sort(byOccurrence),
    [incidentId],
  );
}

/** A change line, in words: "Status: New → Investigating". */
export function useChangeWords(): (line: Pick<IncidentUpdate, 'field' | 'old_value' | 'new_value'>) => string {
  const t = useT();
  const value = (field: string | null, raw: string | null): string => {
    if (raw === null) return '—';
    if (field === 'status' && isIncidentStatus(raw)) return t(statusKey(raw));
    if (field === 'priority' && isIncidentPriority(raw)) return t(priorityKey(raw));
    if (field === 'manager_id') return byId('user', raw)?.name ?? t('incident.someone');
    return raw;
  };
  return (line) => {
    if (line.field === 'status' && line.old_value === null) {
      return t('incident.change.opened', { status: value('status', line.new_value) });
    }
    const label = line.field === 'status' ? t('incident.status')
      : line.field === 'priority' ? t('incident.priority')
        : line.field === 'manager_id' ? t('incident.manager')
          : String(line.field ?? '');
    return `${label}: ${value(line.field, line.old_value)} → ${value(line.field, line.new_value)}`;
  };
}

export function Timeline({ incident }: { incident: Incident }) {
  const t = useT();
  const me = useMe();
  const canWrite = useCanWrite();
  const lines = useTimeline(incident.id);
  const changeWords = useChangeWords();
  const { confirm, dialog } = useConfirm();

  return (
    <div className="flex flex-col gap-3">
      {canWrite && <Composer incident={incident} />}
      {!lines.length ? (
        <p className="text-body text-muted">{t('incident.timelineEmpty')}</p>
      ) : (
        <ol className="incident-timeline">
          {[...lines].reverse().map((line) => {
            const author = line.author_id ? byId('user', line.author_id) : null;
            if (line.kind === 'change') {
              return (
                <li key={line.id} className="incident-line incident-line-change">
                  <time className="incident-line-time" dateTime={new Date(line.occurred_at).toISOString()}>{exactTime(line.occurred_at)}</time>
                  <span>{changeWords(line)}{author ? ` · ${author.name}` : ''}</span>
                </li>
              );
            }
            return (
              <li key={line.id} className="incident-line">
                <div className="flex flex-wrap items-center gap-2">
                  {author && <Avatar user={author} size={20} />}
                  <strong className="text-body">{author?.name ?? t('incident.someone')}</strong>
                  <Chip>{line.kind === 'note' ? t('incident.kind.note') : t('incident.kind.update')}</Chip>
                  <time className="incident-line-time" dateTime={new Date(line.occurred_at).toISOString()}>{exactTime(line.occurred_at)}</time>
                  {line.author_id === me && (
                    <Button
                      size="sm"
                      className="ml-auto"
                      title={t('incident.deleteLine')}
                      aria-label={t('incident.deleteLine')}
                      onClick={async () => {
                        if (await confirm(t('incident.deleteLineConfirm'), t('action.delete'))) remove('incidentUpdate', line.id);
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </Button>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-body">{line.body}</p>
              </li>
            );
          })}
        </ol>
      )}
      {dialog}
    </div>
  );
}

/**
 * Say something, and optionally move the status with it.
 *
 * The status select starts on "leave it": an update is far more often "still
 * looking" than a move, and a composer that defaulted to the current status
 * would rewrite it with every line and fill the timeline with no-op changes.
 */
function Composer({ incident }: { incident: Incident }) {
  const t = useT();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'update' | 'note'>('update');
  const [status, setStatus] = useState<IncidentStatus | ''>('');
  const [backdate, setBackdate] = useState(false);
  const [at, setAt] = useState('');
  const statuses = useMemo(() => INCIDENT_STATUS.filter((one) => one !== incident.status), [incident.status]);

  return (
    <form
      className="incident-composer flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const text = body.trim();
        if (!text) return;
        create('incidentUpdate', {
          incident_id: incident.id,
          kind,
          body: text,
          occurred_at: backdate && at ? new Date(at).getTime() : now(),
          field: null,
          old_value: null,
          new_value: null,
        });
        if (status) update('incident', incident.id, { status });
        setBody('');
        setStatus('');
        setBackdate(false);
        setAt('');
      }}
    >
      <Label label={t('incident.saySomething')}>
        <Textarea
          rows={2}
          value={body}
          placeholder={kind === 'note' ? t('incident.notePlaceholder') : t('incident.updatePlaceholder')}
          onChange={(event) => setBody(event.target.value)}
        />
      </Label>
      <div className="flex flex-wrap items-end gap-2">
        <Label label={t('incident.lineKind')}>
          <Select inputSize="sm" value={kind} onChange={(event) => setKind(event.target.value as 'update' | 'note')}>
            <option value="update">{t('incident.kind.update')}</option>
            <option value="note">{t('incident.kind.note')}</option>
          </Select>
        </Label>
        <Label label={t('incident.moveTo')}>
          <Select inputSize="sm" value={status} onChange={(event) => setStatus(event.target.value as IncidentStatus | '')}>
            <option value="">{t('incident.leaveStatus')}</option>
            {statuses.map((one) => <option key={one} value={one}>{t(statusKey(one))}</option>)}
          </Select>
        </Label>
        {backdate ? (
          <Label label={t('incident.happenedAt')}>
            <Input
              inputSize="sm"
              type="datetime-local"
              value={at || asLocalInput(now())}
              onChange={(event) => setAt(event.target.value)}
            />
          </Label>
        ) : (
          <Button size="sm" type="button" onClick={() => setBackdate(true)}>{t('incident.backdate')}</Button>
        )}
        <Button variant="primary" size="sm" type="submit" className="ml-auto" disabled={!body.trim()}>
          {t('incident.post')}
        </Button>
      </div>
    </form>
  );
}
