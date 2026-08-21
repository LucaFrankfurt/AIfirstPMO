import { useMemo, useState } from 'react';
import { parseQuery, printQuery, hasUnprintable, type Filters, type QueryVocabulary } from '@kolibri/shared';
import { useT } from '../lib/i18n';
import { useMe, useMembers } from '../session';
import { list, useQuery } from '../lib/store';
import { useLabels, useStates, useTypes } from './task-parts';
import { Button } from './ui/button';
import { Icon, Sheet } from './ui';

/**
 * The filter, as text.
 *
 * Two views of one thing: whatever the menus did prints into this box, and
 * whatever is typed here comes back out as the same menu state. That is the
 * whole design, and it is why the box shows the *current* filter when it opens
 * rather than an empty line — a query language you have to learn before it
 * shows you anything is one nobody learns.
 *
 * Errors are shown and the query is still applied. Half a filter is more useful
 * than none: the clauses that parsed take effect, and the sentence under the box
 * names the word to fix. What is never done is silently dropping a clause — a
 * filter that quietly widens is worse than one that matches nothing and says so.
 */
export function QueryBox({
  filters, onChange, projectId, workspaceId,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
  projectId?: string;
  workspaceId: string;
}) {
  const t = useT();
  const me = useMe();
  const members = useMembers();
  const states = useStates(projectId);
  const types = useTypes(projectId);
  const labels = useLabels(projectId);

  const cycles = useQuery(() => list('cycle', (row) => row.workspace_id === workspaceId), [workspaceId]);
  const modules = useQuery(() => list('module', (row) => row.workspace_id === workspaceId), [workspaceId]);
  const projects = useQuery(() => list('project', (row) => row.workspace_id === workspaceId), [workspaceId]);

  const vocabulary: QueryVocabulary = useMemo(() => ({
    meId: me,
    states: states.map((row) => ({ id: row.id, name: row.name, group_key: row.group_key })),
    types: types.map((row) => ({ id: row.id, name: row.name })),
    people: members.map((row) => ({ id: row.id, name: row.name, email: row.email })),
    labels: labels.map((row) => ({ id: row.id, name: row.name })),
    cycles: cycles.map((row) => ({ id: row.id, name: row.name })),
    modules: modules.map((row) => ({ id: row.id, name: row.name })),
    projects: projects.map((row) => ({ id: row.id, key: row.key, name: row.name })),
  }), [me, states, types, members, labels, cycles, modules, projects]);

  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  const parsed = useMemo(() => parseQuery(text, vocabulary), [text, vocabulary]);

  const show = () => {
    setText(printQuery(filters, vocabulary));
    setOpen(true);
  };

  const apply = () => {
    // The custom-field part of a filter has no syntax yet, so it is carried
    // across untouched rather than thrown away by a box that cannot show it.
    onChange({ ...parsed.filters, field: filters.field });
    setOpen(false);
  };

  return (
    <>
      <Button
        size="sm" onClick={show}
        title={t('query.title')} aria-label={t('query.title')}
      >
        <Icon name="search" size={14} />
        <span className="hide-sm">{t('query.short')}</span>
      </Button>

      {open && (
        <Sheet
          title={t('query.title')}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => { setText(''); }}>{t('view.clearFilters')}</Button>
              <Button variant="primary" onClick={apply}>{t('query.apply')}</Button>
            </>
          }
        >
          <textarea
            autoFocus
            rows={3}
            className="w-full bg-raised text-fg rounded-[var(--radius-sm)] border border-line-strong p-2.5 font-mono text-[13px]"
            aria-label={t('query.title')}
            placeholder={t('query.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                apply();
              }
            }}
          />

          {parsed.errors.length > 0 && (
            <ul className="text-[12.5px] text-danger list-none p-0 mt-2 mb-0">
              {parsed.errors.map((error) => (
                <li key={`${error.at}-${error.message}`} className="flex items-start gap-1.5 mb-1">
                  <Icon name="bolt" size={13} />
                  <span>{error.message}</span>
                </li>
              ))}
            </ul>
          )}

          {hasUnprintable(filters) && (
            <p className="mt-2 text-[12.5px] text-muted">{t('query.fieldsKept')}</p>
          )}

          <p className="mt-3 text-[12.5px] text-muted">{t('query.help')}</p>
          <pre className="md text-[12px] mt-1" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--line)', padding: 10, borderRadius: 8, overflowX: 'auto' }}>
{`assignee = me AND state != Done
priority in (urgent, high) AND due = overdue
project = WEB AND label in (design, ops)
is: open AND cycle = none`}
          </pre>
        </Sheet>
      )}
    </>
  );
}
