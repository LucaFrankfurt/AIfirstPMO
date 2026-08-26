/**
 * Search, for people who do not know the app.
 *
 * One box, prose in it, answers underneath. Everything that used to require
 * knowing where to look — whose task it is, which label it carries, which
 * project it belongs to — is offered *while typing*: `@`, `#` and `+` each
 * open a list of real names, and picking one narrows the search. Nothing has
 * to be learnt first, because the list is what teaches it.
 *
 * The reading of the box lives in `lib/search-query`; this file is the screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { excerpt, type Task } from '@kolibri/shared';
import { Header } from '../components/AppShell';
import { TaskRow } from '../components/task-parts';
import { Avatar, Empty, Icon, useToast } from '../components/ui';
import { Chip, chipDot } from '../components/ui/chip';
import { Input } from '../components/ui/field';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { useT, type TranslationKey } from '../lib/i18n';
import { useOpenTask } from '../lib/navigation';
import { byId, list, useQuery } from '../lib/store';
import {
  applySuggestion, matchesTerms, parseQuery, removeFacet, suggest, terms, TRIGGER_OF,
  type Facet, type FacetKind, type FacetOption,
} from '../lib/search-query';
import { useMembers, useSession } from '../session';

interface Hit {
  kind: string;
  id: string;
  title: string;
  snippet: string;
  projectId?: string | null;
}

const KIND_ICON: Record<string, string> = {
  task: 'check', page: 'page', project: 'folder',
  comment: 'chat', message: 'chat', cycle: 'cycle', module: 'board',
};

const KIND_GROUP: Record<string, TranslationKey> = {
  task: 'search.groupTasks', page: 'search.groupPages', project: 'search.groupProjects',
  comment: 'search.groupComments', message: 'search.groupMessages',
  cycle: 'search.groupCycles', module: 'search.groupModules',
};

/** Work first, then what is written about it. */
const KIND_ORDER = ['task', 'page', 'project', 'cycle', 'module', 'comment', 'message'];

/**
 * A row from the server, in the shape the rest of this file uses. The rename
 * is the whole of it — and it matters, because `project_id` read as
 * `projectId` is `undefined` rather than an error, and a search narrowed to a
 * project would quietly have thrown away every full-text hit.
 */
const asHit = (row: { kind: string; id: string; title: string; snippet: string; project_id: string | null }): Hit => ({
  kind: row.kind,
  id: row.id,
  title: row.title,
  // A comment has no title of its own, so the server sends the matching line
  // as both. Printed twice it reads as a bug rather than as emphasis.
  snippet: row.snippet === row.title ? '' : row.snippet,
  projectId: row.project_id,
});

/**
 * Which project a hit belongs to.
 *
 * The index answers for most kinds and cannot for two: a comment is filed
 * against a task or a page rather than a project, and a message against a
 * channel. Both are one hop away in the local copy, and without the hop a
 * search narrowed to a project throws away every comment in it.
 */
function projectOf(hit: Hit): string | null {
  if (hit.projectId) return hit.projectId;
  if (hit.kind === 'comment') {
    const comment = byId('comment', hit.id);
    if (comment?.task_id) return byId('task', comment.task_id)?.project_id ?? null;
    if (comment?.page_id) return byId('page', comment.page_id)?.project_id ?? null;
  }
  if (hit.kind === 'message') {
    return byId('channel', byId('message', hit.id)?.channel_id)?.project_id ?? null;
  }
  return null;
}

/** The task a hit is about, for the hits that are about one. */
const taskOf = (hit: Hit): string | null => (hit.kind === 'task' ? hit.id
  : hit.kind === 'comment' ? byId('comment', hit.id)?.task_id ?? null
    : null);

const FACET_LABEL: Record<FacetKind, TranslationKey> = {
  person: 'search.facetPerson', label: 'search.facetLabel', project: 'search.facetProject',
};

const FACET_HEADING: Record<FacetKind, TranslationKey> = {
  person: 'search.suggestPeople', label: 'search.suggestLabels', project: 'search.suggestProjects',
};

/* ------------------------------------------------------------- vocabulary */

/**
 * Every name the box will recognise.
 *
 * Deduplicated by name: two projects may each have a label called "Bug", and
 * somebody filtering by `#Bug` means both — one chip, both ids behind it.
 */
function useFacetOptions(): FacetOption[] {
  const { workspaceId } = useSession();
  const members = useMembers();
  const labels = useQuery(() => list('label', (label) => label.workspace_id === workspaceId), [workspaceId]);
  const projects = useQuery(
    () => list('project', (project) => project.workspace_id === workspaceId && !project.archived),
    [workspaceId],
  );

  return useMemo(() => {
    const byName = new Map<string, FacetOption>();
    const add = (option: FacetOption) => {
      if (!option.name.trim()) return;
      const key = `${option.kind}:${option.name.toLowerCase()}`;
      const existing = byName.get(key);
      if (existing) existing.ids.push(...option.ids);
      else byName.set(key, option);
    };
    for (const member of members) add({ kind: 'person', ids: [member.id], name: member.name, hint: member.email });
    for (const label of labels) add({ kind: 'label', ids: [label.id], name: label.name, color: label.color });
    for (const project of projects) add({ kind: 'project', ids: [project.id], name: project.name, hint: project.key });
    return [...byName.values()];
  }, [members, labels, projects]);
}

/* ------------------------------------------------------------------- box */

/**
 * The box itself: an ordinary text field that happens to know some names.
 *
 * It is a combobox only while a list is open — the rest of the time it is a
 * search field and announces itself as one, which is the truth and also what
 * makes the popup worth noticing when it does appear.
 */
function SearchBox({
  value, onChange, options, autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  options: FacetOption[];
  autoFocus?: boolean;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  // Pressing anywhere else puts the list away. On `pointerdown` rather than on
  // the field losing focus, because on a phone the focus goes *first* and the
  // list would be gone before the tap that was aimed at it ever landed.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      setDismissed(!boxRef.current?.contains(event.target as Node));
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const suggestion = useMemo(
    () => (dismissed ? null : suggest(value, caret, options)),
    [dismissed, value, caret, options],
  );

  // The highlight goes back to the top whenever the list is a different list.
  useEffect(() => setActive(0), [suggestion?.trigger.start, suggestion?.trigger.term]);

  // Putting a name into a controlled input moves the caret to the end of it,
  // so the caret is restored after the value has actually landed — not in the
  // handler, where the field still holds the old text.
  useEffect(() => {
    const at = pendingCaret.current;
    if (at == null) return;
    pendingCaret.current = null;
    const element = inputRef.current;
    element?.focus();
    element?.setSelectionRange(at, at);
    setCaret(at);
  }, [value]);

  const sync = (element: HTMLInputElement) => setCaret(element.selectionStart ?? element.value.length);

  const choose = (option: FacetOption) => {
    if (!suggestion) return;
    const next = applySuggestion(value, suggestion.trigger, option);
    pendingCaret.current = next.caret;
    onChange(next.value);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && suggestion) {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      return;
    }
    if (!suggestion) return;
    const count = suggestion.options.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (current + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (current - 1 + count) % count);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(suggestion.options[active] ?? suggestion.options[0]);
    }
  };

  return (
    <div className="relative" ref={boxRef}>
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        type="text"
        role={suggestion ? 'combobox' : undefined}
        aria-expanded={suggestion ? true : undefined}
        aria-controls={suggestion ? 'search-suggestions' : undefined}
        aria-autocomplete={suggestion ? 'list' : undefined}
        aria-activedescendant={suggestion ? `search-suggestion-${active}` : undefined}
        aria-label={t('search.title')}
        placeholder={t('search.placeholder')}
        value={value}
        className="text-base"
        onChange={(event) => {
          setDismissed(false);
          onChange(event.target.value);
          sync(event.target);
        }}
        onSelect={(event) => sync(event.currentTarget)}
        onKeyDown={onKeyDown}
      />
      {suggestion && (
        <div
          id="search-suggestions"
          role="listbox"
          aria-label={t(FACET_HEADING[suggestion.trigger.kind])}
          className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-[var(--radius)] border border-line bg-raised p-1 shadow-[var(--shadow)]"
        >
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            {t(FACET_HEADING[suggestion.trigger.kind])}
          </div>
          {suggestion.options.map((option, index) => (
            <button
              key={`${option.kind}-${option.ids.join('-')}`}
              id={`search-suggestion-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[13.5px] text-fg',
                index === active && 'bg-hover',
              )}
              // The field keeps the focus, so the list does not close under the
              // pointer before the click it was aimed at ever arrives.
              onMouseDown={(event) => event.preventDefault()}
              onPointerEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              <FacetGlyph option={option} />
              <span className="min-w-0 flex-1 truncate">{option.name}</span>
              {option.hint && <span className="mono truncate text-[11.5px] text-muted">{option.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FacetGlyph({ option }: { option: FacetOption }) {
  if (option.kind === 'person') {
    const user = byId('user', option.ids[0]);
    return <Avatar user={user ?? { id: option.ids[0], name: option.name }} size={20} />;
  }
  if (option.kind === 'label') {
    return <span className={cn(chipDot, 'mx-[6px]')} style={{ background: option.color ?? 'var(--fg-muted)' }} />;
  }
  return <Icon name="folder" size={15} />;
}

/* ---------------------------------------------------------------- results */

export function Search() {
  const t = useT();
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const openTask = useOpenTask();
  const toast = useToast();
  const options = useFacetOptions();

  // The query lives in the URL, so a search can be linked, reloaded, and
  // arrived at from ⌘K with the words already in it.
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const [input, setInput] = useState(urlQuery);
  const written = useRef(urlQuery);

  useEffect(() => {
    if (urlQuery === written.current) return;
    written.current = urlQuery;
    setInput(urlQuery);
  }, [urlQuery]);

  useEffect(() => {
    if (input === written.current) return;
    const handle = setTimeout(() => {
      written.current = input;
      setParams(input ? { q: input } : {}, { replace: true });
    }, 400);
    return () => clearTimeout(handle);
  }, [input, setParams]);

  const { text, facets } = useMemo(() => parseQuery(input, options), [input, options]);
  const words = useMemo(() => terms(text), [text]);
  const facetKey = facets.map((facet) => `${facet.kind}:${facet.ids.join('|')}`).join(',');
  const wordKey = words.join(' ');
  const asked = words.length > 0 || facets.length > 0;
  /** A person or a label is a thing only work can have. */
  const workOnly = facets.some((facet) => facet.kind !== 'project');

  const tasks = useQuery(() => {
    if (!asked) return [];
    const sets = (kind: FacetKind) => facets.filter((facet) => facet.kind === kind).map((facet) => new Set(facet.ids));
    const people = sets('person');
    const labels = sets('label');
    const projects = sets('project');
    const titled = (task: Task) => matchesTerms(`${task.identifier} ${task.title}`, words);
    return list('task', (task) => task.workspace_id === workspaceId && !task.archived
      && people.every((set) => (task.assignees ?? []).some((id) => set.has(id)))
      && labels.every((set) => (task.labels ?? []).some((id) => set.has(id)))
      && projects.every((set) => set.has(task.project_id))
      && matchesTerms(`${task.identifier} ${task.title} ${task.description ?? ''}`, words))
      // A word in the title beats the same word buried in a description, and
      // among equals the one somebody touched last week is the likelier one.
      .sort((a, b) => Number(titled(b)) - Number(titled(a)) || b.updated_at - a.updated_at)
      .slice(0, 50);
  }, [workspaceId, wordKey, facetKey, asked]);

  // The same filters, without the words. A comment found by the server sits on
  // a task whose *title* need not contain the search at all, so asking whether
  // that task passed the whole query would throw the comment away; asking
  // whether it passed the filters is the actual question.
  const scope = useQuery(() => {
    if (!workOnly) return null;
    const sets = (kind: FacetKind) => facets.filter((facet) => facet.kind === kind).map((facet) => new Set(facet.ids));
    const people = sets('person');
    const labels = sets('label');
    const projects = sets('project');
    return new Set(list('task', (task) => task.workspace_id === workspaceId && !task.archived
      && people.every((set) => (task.assignees ?? []).some((id) => set.has(id)))
      && labels.every((set) => (task.labels ?? []).some((id) => set.has(id)))
      && projects.every((set) => set.has(task.project_id))).map((task) => task.id));
  }, [workspaceId, facetKey, workOnly]);

  const local = useQuery<Hit[]>(() => {
    if (!words.length || workOnly) return [];
    const projects = facets.filter((facet) => facet.kind === 'project').map((facet) => new Set(facet.ids));
    const inScope = (projectId: string | null) => projects.every((set) => projectId && set.has(projectId));
    const pages = list('page', (page) => page.workspace_id === workspaceId && !page.archived
      && inScope(page.project_id ?? null) && matchesTerms(page.title, words)).slice(0, 12);
    const found = list('project', (project) => project.workspace_id === workspaceId && !project.archived
      && (!projects.length || projects.every((set) => set.has(project.id)))
      && matchesTerms(`${project.key} ${project.name}`, words)).slice(0, 8);
    return [
      ...pages.map((page) => ({ kind: 'page', id: page.id, title: page.title, snippet: excerpt(page.content, 90), projectId: page.project_id ?? null })),
      ...found.map((project) => ({ kind: 'project', id: project.id, title: `${project.icon ?? ''} ${project.name}`.trim(), snippet: project.description ?? '', projectId: project.id })),
    ];
  }, [workspaceId, wordKey, facetKey, workOnly]);

  const [remote, setRemote] = useState<Hit[]>([]);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!workspaceId || text.trim().length < 2) {
      setRemote([]);
      setWaiting(false);
      return;
    }
    setWaiting(true);
    // `live` is what keeps a slow answer to an old question from replacing a
    // fast answer to the current one — the request cannot be recalled, but its
    // result can be ignored.
    let live = true;
    const handle = setTimeout(() => {
      api.search(workspaceId, text)
        .then((response) => live && (setRemote(response.results.map(asHit)), setWaiting(false)))
        .catch(() => live && (setRemote([]), setWaiting(false)));
    }, 220);
    return () => {
      live = false;
      clearTimeout(handle);
    };
  }, [text, workspaceId]);

  const sections = useMemo(() => {
    const hits: Hit[] = [
      ...tasks.map((task) => ({ kind: 'task', id: task.id, title: `${task.identifier} ${task.title}`, snippet: '', projectId: task.project_id })),
      ...local,
    ];
    const seen = new Set(hits.map((hit) => `${hit.kind}:${hit.id}`));
    const projects = facets.filter((facet) => facet.kind === 'project').map((facet) => new Set(facet.ids));

    for (const hit of remote) {
      const key = `${hit.kind}:${hit.id}`;
      if (seen.has(key)) continue;
      // The index keeps archived work — the doctor checks the index against
      // the table and a hole in it is a fault. Archived work is hidden
      // everywhere else in the app, so it is hidden here too.
      if (hit.kind === 'task' && byId('task', hit.id)?.archived) continue;
      if (projects.length) {
        const where = projectOf(hit);
        if (!where || !projects.every((set) => set.has(where))) continue;
      }
      if (scope) {
        // A page has no assignee and a project carries no label, so a search
        // narrowed by one of those is a search through work: what is kept is
        // the work the filters allow, and what was written on it.
        const about = taskOf(hit);
        if (!about || !scope.has(about)) continue;
      }
      seen.add(key);
      hits.push(hit);
    }

    return KIND_ORDER
      .map((kind) => ({ kind, hits: hits.filter((hit) => hit.kind === kind) }))
      .filter((section) => section.hits.length);
  }, [tasks, local, remote, facetKey, scope]);

  const total = sections.reduce((sum, section) => sum + section.hits.length, 0);

  const open = (hit: Hit) => {
    if (hit.kind === 'task') openTask({ id: hit.id });
    else if (hit.kind === 'page') navigate(`/pages/${hit.id}`);
    else if (hit.kind === 'project') navigate(`/projects/${hit.id}`);
    else if (hit.kind === 'cycle' || hit.kind === 'module') navigate(`/projects/${hit.projectId ?? ''}`);
    else if (hit.kind === 'comment') {
      const comment = byId('comment', hit.id);
      if (comment?.task_id) openTask({ id: comment.task_id });
      else if (comment?.page_id) navigate(`/pages/${comment.page_id}`);
      else toast(t('search.commentGone'));
    } else if (hit.kind === 'message') {
      // The conversation, not the message: a stream has no anchor to scroll to
      // and pretending otherwise would be a link that lands in the wrong place.
      const message = byId('message', hit.id);
      if (message?.channel_id) navigate(`/chat/${message.channel_id}`);
      else toast(t('search.messageGone'));
    }
  };

  return (
    <>
      <Header title={t('search.title')} />
      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <SearchBox autoFocus value={input} onChange={setInput} options={options} />

        {facets.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {facets.map((facet) => (
              <FacetChip
                key={`${facet.kind}-${facet.start}`}
                facet={facet}
                onRemove={() => setInput(removeFacet(input, facet))}
              />
            ))}
          </div>
        )}

        {!asked ? (
          <Tips />
        ) : total === 0 ? (
          waiting ? (
            <p className="py-10 text-center text-muted">{t('search.searching')}</p>
          ) : (
            <Empty emoji="🫙" title={t('search.noResults', { query: input.trim() })} hint={t('search.noResultsHint')} />
          )
        ) : (
          <div className="mt-3.5">
            {workOnly && words.length > 0 && <p className="mb-2 text-[12.5px] text-muted">{t('search.workOnly')}</p>}
            {sections.map((section) => (
              <section key={section.kind} className="mb-4">
                <h2 className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  {t(KIND_GROUP[section.kind] ?? 'search.groupOther')}
                  <span className="font-normal normal-case tracking-normal">{section.hits.length}</span>
                </h2>
                {section.hits.map((hit) => <Result key={`${hit.kind}-${hit.id}`} hit={hit} onOpen={open} />)}
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** A task is drawn the way a task is drawn everywhere else in the app. */
function Result({ hit, onOpen }: { hit: Hit; onOpen: (hit: Hit) => void }) {
  const task = hit.kind === 'task' ? byId('task', hit.id) : undefined;
  if (task) return <TaskRow task={task} onOpen={() => onOpen(hit)} showProject />;
  // The heading above already says what kind of thing this is, so the space at
  // the end of the row says where it is instead — which is the question
  // somebody looking at two pages of the same name actually has.
  const project = hit.kind === 'project' ? undefined : byId('project', projectOf(hit));
  return (
    <button type="button" className="task-row w-full text-left" onClick={() => onOpen(hit)}>
      <Icon name={KIND_ICON[hit.kind] ?? 'page'} size={15} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{hit.title || hit.snippet}</span>
        {hit.snippet && hit.title && <span className="block truncate text-[12.5px] text-muted">{hit.snippet}</span>}
      </span>
      {project && <span className="truncate text-[11.5px] text-muted">{project.name}</span>}
    </button>
  );
}

function FacetChip({ facet, onRemove }: { facet: Facet; onRemove: () => void }) {
  const t = useT();
  return (
    <Chip tone="on" className="pr-1">
      <span className="text-muted">{t(FACET_LABEL[facet.kind])}</span>
      {facet.kind === 'label' && <span className={chipDot} style={{ background: facet.color ?? 'var(--fg-muted)' }} />}
      <span className="truncate">{facet.name}</span>
      <button
        type="button"
        className="ml-0.5 grid size-6 place-items-center rounded-full hover:bg-active"
        aria-label={t('search.removeFilter', { name: facet.name })}
        onClick={onRemove}
      >
        <Icon name="close" size={12} />
      </button>
    </Chip>
  );
}

/**
 * The empty screen carries the whole feature.
 *
 * Somebody who has never used a filter in their life reads three lines here
 * and then types `@` — which is the only moment this can be taught, because
 * afterwards the screen is full of results and nobody reads it.
 */
function Tips() {
  const t = useT();
  const rows: { kind: FacetKind; hint: TranslationKey }[] = [
    { kind: 'person', hint: 'search.tipPerson' },
    { kind: 'label', hint: 'search.tipLabel' },
    { kind: 'project', hint: 'search.tipProject' },
  ];
  return (
    <div className="mx-auto mt-10 max-w-[420px]">
      <h2 className="mb-1 text-center text-[15px] font-semibold">{t('search.promptTitle')}</h2>
      <p className="mb-4 text-center text-muted">{t('search.promptHint')}</p>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li key={row.kind} className="flex items-center gap-2.5 text-[13px] text-soft">
            <span className="mono grid size-7 flex-none place-items-center rounded-[var(--radius-sm)] border border-line bg-hover text-[13px]">
              {TRIGGER_OF[row.kind]}
            </span>
            {t(row.hint)}
          </li>
        ))}
      </ul>
    </div>
  );
}
