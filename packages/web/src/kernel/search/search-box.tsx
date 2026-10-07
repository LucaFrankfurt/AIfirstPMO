/**
 * The box you type a query into — wherever that box is standing.
 *
 * It used to live inside `routes/search.tsx`, which meant rule 3 made it
 * unreachable from anywhere else: only the shell may import a route file. So
 * when the task list grew a filter-as-text box, that box could not be this
 * one, and the product ended up with two inputs that both carry a magnifier
 * and understand different languages — `@anna` in one of them, `assignee =
 * anna` in the other, and neither accepting the other's spelling.
 *
 * Nothing here knows what a query *means*. It offers names after `@`, `#` and
 * `+`, puts the chosen one into the text, and hands the whole line back. What
 * the line then does — search everything, or narrow the list in front of you —
 * is the caller's business, and that is exactly the seam that lets one box
 * stand in two places without either screen pretending to be the other.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, Icon } from '../design-system/ui';
import { chipDot } from '../design-system/ui/chip';
import { Input } from '../design-system/ui/field';
import { cn } from '../design-system/cn';
import { useT, type TranslationKey } from '../i18n/i18n';
import { byId, list, useQuery } from '../sync/store';
import { useMe, useMembers, useSession } from '../identity/session';
import {
  applySuggestion, suggest,
  type FacetKind, type FacetOption,
} from './search-query';
import { coversProject, type QueryVocabulary } from '@kolibri/shared';

export const FACET_LABEL: Record<FacetKind, TranslationKey> = {
  person: 'search.facetPerson', label: 'search.facetLabel', project: 'search.facetProject',
};

export const FACET_HEADING: Record<FacetKind, TranslationKey> = {
  person: 'search.suggestPeople', label: 'search.suggestLabels', project: 'search.suggestProjects',
};

/* ------------------------------------------------------------- vocabulary */

/**
 * Every name the box will recognise.
 *
 * Deduplicated by name: two projects may each have a label called "Bug", and
 * somebody filtering by `#Bug` means both — one chip, both ids behind it.
 */
export function useFacetOptions(projectId?: string | null): FacetOption[] {
  const { workspaceId } = useSession();
  const members = useMembers();
  // Scoped like the clause vocabulary below, and for the same reason: inside a
  // project, `#Bug` has to offer that project's labels and the workspace's, not
  // another project's. A name offered that can only ever match nothing is worse
  // than a name not offered.
  const labels = useQuery(
    () => list('label', (label) => label.workspace_id === workspaceId
      && (!label.project_id || !projectId || label.project_id === projectId)),
    [workspaceId, projectId],
  );
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
export function SearchBox({
  value, onChange, onSubmit, options, autoFocus, placeholder, label, loose, below,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Enter with no list open. What a typed identifier is a short cut *to*. */
  onSubmit?: () => void;
  options: FacetOption[];
  autoFocus?: boolean;
  placeholder?: string;
  label?: string;
  /**
   * Hang the list off the body instead of off the field.
   *
   * Needed wherever the box stands inside something that clips: the task
   * header is `overflow-x: auto` so it can scroll on a phone, and CSS computes
   * the *other* axis to `auto` the moment one axis is not `visible` — so a list
   * drawn inside it is not merely cut off, it turns the header into a thing you
   * scroll downwards. The search screen has no such ancestor and does not pay
   * for this.
   */
  loose?: boolean;
  /** Shown under the field when there is no list — errors, or what to type. */
  below?: React.ReactNode;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  /**
   * Whether anybody is actually typing in here.
   *
   * Only the hint cares. A list of names appears because a trigger character
   * was typed, which cannot happen unfocused — but `below` is shown for an
   * empty field, and without this the hint hung under the header of every task
   * list all day, a panel floating over the rows nobody had asked anything of.
   */
  const [focused, setFocused] = useState(false);

  // Pressing anywhere else puts the list away. On `pointerdown` rather than on
  // the field losing focus, because on a phone the focus goes *first* and the
  // list would be gone before the tap that was aimed at it ever landed.
  //
  // `panelRef` is in the question for the same reason the panel exists: once it
  // is portalled out to escape a clipping ancestor it is no longer *inside* the
  // box, so "pressed somewhere else" became true of the list itself. Every pick
  // dismissed the list under the pointer and the name never landed — the field
  // kept the bare `@` somebody had typed.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      setDismissed(!boxRef.current?.contains(target) && !panelRef.current?.contains(target));
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
    // Enter while a name is being offered picks the name; that list is the more
    // immediate thing on screen and taking it away would be the surprise.
    if (event.key === 'Enter' && !suggestion) {
      event.preventDefault();
      onSubmit?.();
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

  /**
   * Where a loose panel goes: under the field, as wide as the field.
   *
   * Re-measured while one is open rather than once, because the header it
   * hangs under is sticky and what is behind it scrolls and resizes.
   */
  const showBelow = below != null && focused;
  const anchor = useAnchor(boxRef, !!loose && !!(suggestion || showBelow));

  const panel = (body: React.ReactNode, props: Record<string, unknown>) => {
    const element = (
      <div
        ref={panelRef}
        {...props}
        className={cn(
          'z-30 overflow-hidden rounded-[var(--radius)] border border-line bg-raised p-1 shadow-[var(--shadow)]',
          loose ? 'fixed' : 'absolute inset-x-0 top-full mt-1',
        )}
        style={loose ? anchor : undefined}
      >
        {body}
      </div>
    );
    return loose ? createPortal(element, document.body) : element;
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
        aria-label={label ?? t('search.title')}
        placeholder={placeholder ?? t('search.placeholder')}
        value={value}
        className="text-base"
        onChange={(event) => {
          setDismissed(false);
          onChange(event.target.value);
          sync(event.target);
        }}
        onSelect={(event) => sync(event.currentTarget)}
        onFocus={() => setFocused(true)}
        // Late enough for a click on the panel to have landed, which is what
        // `onMouseDown` on the rows is already protecting the list from.
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={onKeyDown}
      />
      {suggestion && panel(
        <>
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
        </>,
        {
          id: 'search-suggestions',
          role: 'listbox',
          'aria-label': t(FACET_HEADING[suggestion.trigger.kind]),
        },
      )}
      {/* Only when no list is open: a name being offered is the more immediate
          thing, and two panels under one field is two answers to one question. */}
      {!suggestion && showBelow && panel(below, {})}
    </div>
  );
}

/**
 * The rectangle a loose panel is pinned to, or nothing while none is open.
 *
 * `fixed` rather than `absolute` because the point is to escape an ancestor
 * that clips; that costs the panel its anchor, so the anchor is measured. It
 * follows scrolling and resizing — the header is sticky, but the field inside
 * it still moves when the sidebar opens or the window changes shape.
 */
function useAnchor(ref: React.RefObject<HTMLDivElement | null>, live: boolean) {
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  useEffect(() => {
    if (!live) { setBox(null); return; }
    const measure = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) setBox({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    };
    measure();
    // `true` so a scroll inside any ancestor counts, not only the window's own.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [live, ref]);

  return box ?? undefined;
}

export function FacetGlyph({ option }: { option: FacetOption }) {
  if (option.kind === 'person') {
    const user = byId('user', option.ids[0]);
    return <Avatar user={user ?? { id: option.ids[0], name: option.name }} size={20} />;
  }
  if (option.kind === 'label') {
    return <span className={cn(chipDot, 'mx-[6px]')} style={{ background: option.color ?? 'var(--fg-muted)' }} />;
  }
  return <Icon name="folder" size={15} />;
}

/**
 * What names mean here — the other half of what the box knows.
 *
 * `useFacetOptions` above answers "which names open a list"; this answers
 * "which names a clause may resolve", and the two have to be the same names or
 * `@Anna` and `assignee = Anna` would find different people. The task list's
 * header built this inline, so it existed once per screen and only there.
 *
 * Scoped by project the way the work module's own `useStates` and `useLabels`
 * are, and written out here rather than borrowed from them: those live in a
 * capability, and a kernel file leaning on one is the arrow rule 5 refuses.
 * The scoping is the part that must not drift — a state named in a project
 * view has to mean that project's state — so it is stated, not implied.
 */
export function useVocabulary(projectId?: string | null): QueryVocabulary {
  const { workspaceId } = useSession();
  const me = useMe();
  const members = useMembers();
  const states = useQuery(() => list('state', (row) => !projectId || row.project_id === projectId), [projectId]);
  const labels = useQuery(
    () => list('label', (row) => !row.project_id || !projectId || row.project_id === projectId),
    [projectId, workspaceId],
  );
  // `coversProject` and not `project_id`: a cycle or a milestone may be shared,
  // and the filter menu beside this field offers exactly the ones that cover
  // the project. Unscoped, every project's "Cycle 2026-10" was in the same
  // vocabulary, which is a name no clause can name — the field had to print an
  // id to stay exact, and showed a reader a UUID where a word belonged.
  const cycles = useQuery(
    () => list('cycle', (row) => row.workspace_id === workspaceId && (!projectId || coversProject(row, projectId))),
    [workspaceId, projectId],
  );
  const modules = useQuery(
    () => list('module', (row) => row.workspace_id === workspaceId && (!projectId || coversProject(row, projectId))),
    [workspaceId, projectId],
  );
  const projects = useQuery(() => list('project', (row) => row.workspace_id === workspaceId), [workspaceId]);

  return useMemo(() => ({
    meId: me,
    states: states.map((row) => ({ id: row.id, name: row.name, group_key: row.group_key })),
    people: members.map((row) => ({ id: row.id, name: row.name, email: row.email })),
    labels: labels.map((row) => ({ id: row.id, name: row.name })),
    cycles: cycles.map((row) => ({ id: row.id, name: row.name })),
    modules: modules.map((row) => ({ id: row.id, name: row.name })),
    projects: projects.map((row) => ({ id: row.id, key: row.key, name: row.name })),
  }), [me, states, members, labels, cycles, modules, projects]);
}
