import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { enterInList, indentList, renderMarkdown, toggleTask, type Edit, type MarkdownOptions } from '@kolibri/shared';

import { api } from '../lib/api';
import { list, useQuery } from '../lib/store';
import { backgroundOf } from '../lib/navigation';
import { useMembers, useSession } from '../session';
import { useT, type TranslationKey } from '../lib/i18n';
import { buttonVariants } from '../components/ui/button';
import { cn } from '../lib/cn';
import { Avatar, Icon, useLightbox, useToast } from './ui';

/**
 * What a reference in this workspace may point at.
 *
 * The renderer is handed the project keys rather than a pattern, because a
 * pattern cannot tell `WEB-42` from `UTF-8` and a line about an encoding should
 * not sprout a link to a task nobody has. Both come out of the synced cache, so
 * a reference resolves on a train like everything else here.
 */
export function useMarkdownRefs(): MarkdownOptions {
  const { workspaceId } = useSession();
  const projects = useQuery(
    () => list('project', (project) => project.workspace_id === workspaceId && !project.deleted_at),
    [workspaceId],
  );
  return useMemo(() => {
    const byKey = new Map(projects.filter((project) => project.key).map((project) => [project.key as string, project.id]));
    return {
      keys: [...byKey.keys()],
      projectHref: (key: string) => {
        const id = byKey.get(key);
        return id ? `/projects/${id}` : undefined;
      },
    };
  }, [projects]);
}

export function Markdown({ source, className = '', onChange }: {
  source?: string | null;
  className?: string;
  /**
   * Given, the checkboxes can be ticked where they are rendered and this is
   * called with the rewritten markdown.
   *
   * Only where the reader owns the text. A checklist in a task description is
   * meant to be ticked off, and making somebody open an editor to do it is the
   * kind of friction that ends with the checklist going stale. Somebody else's
   * chat message is the opposite case, and stays read-only — the one thing you
   * may do to another person's words here is react to them.
   */
  onChange?: (next: string) => void;
}) {
  const refs = useMarkdownRefs();
  const options = useMemo(() => ({ ...refs, interactiveTasks: !!onChange }), [refs, onChange]);
  const html = useMemo(() => renderMarkdown(source ?? '', options), [source, options]);
  // Click-to-enlarge is delegated: the renderer produces plain HTML, so there
  // are no image components to hand a handler to.
  const { open, lightbox } = useLightbox();
  const navigate = useNavigate();
  const location = useLocation();

  /**
   * Follow a link to somewhere in this app without reloading it.
   *
   * The renderer produces plain anchors, and a plain anchor to `/t/WEB-42` is a
   * full page load — which on an offline-first app means throwing away the
   * cache and the socket to arrive at a screen the router could have drawn.
   * Modified clicks are left alone: opening a task in a new tab is a reasonable
   * thing to want, and taking that away to be clever is not.
   */
  const click = (event: React.MouseEvent<HTMLDivElement>) => {
    open(event);
    // A checkbox does not open a lightbox and is not a link, and on a task
    // description the click behind it opens the editor — so it is answered here
    // and goes no further.
    const box = (event.target as HTMLElement).closest?.('input[type=checkbox][data-task]');
    if (box && onChange) {
      event.preventDefault();
      event.stopPropagation();
      onChange(toggleTask(source ?? '', Number(box.getAttribute('data-task'))));
      return;
    }
    const anchor = (event.target as HTMLElement).closest?.('a');
    const href = anchor?.getAttribute('href');
    if (!anchor || !href?.startsWith('/') || anchor.target === '_blank') return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    // A task opens as a sheet over what you were reading, the way every other
    // task link in the app does.
    const background = href.startsWith('/t/') ? { state: { background: backgroundOf(location) ?? location } } : undefined;
    navigate(href, background);
  };

  if (!source?.trim()) return null;
  return (
    <>
      <div className={`md ${className}`} onClick={click} dangerouslySetInnerHTML={{ __html: html }} />
      {lightbox}
    </>
  );
}

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: number;
  autoFocus?: boolean;
  /** Attach uploaded images to this task/page. */
  attachTo?: { task_id?: string; page_id?: string };
  onSubmit?: () => void;
  /**
   * The textarea itself, for a caller that has to touch the caret.
   *
   * The page editor does: when somebody else's paragraph arrives while you are
   * typing, the text under your cursor changes, and a caret that jumps to the
   * end of the document every time a colleague saves is not collaboration.
   */
  fieldRef?: { current: HTMLTextAreaElement | null };
}

/** One row in the `#` menu — a project or a task, offered the same way. */
interface RefChoice {
  key: string;
  /** What goes into the text: `#WEB`, or `WEB-42`. */
  token: string;
  icon: string;
  label: string;
  hint: string;
}

const SNIPPETS: { icon: string; title: TranslationKey; wrap: [string, string] }[] = [
  { icon: 'B', title: 'editor.bold', wrap: ['**', '**'] },
  { icon: 'I', title: 'editor.italic', wrap: ['_', '_'] },
  { icon: '</>', title: 'editor.code', wrap: ['`', '`'] },
  { icon: '#', title: 'editor.heading', wrap: ['## ', ''] },
  { icon: '•', title: 'editor.bulletList', wrap: ['- ', ''] },
  { icon: '☑', title: 'editor.checklist', wrap: ['- [ ] ', ''] },
  { icon: '❝', title: 'editor.quote', wrap: ['> ', ''] },
];

/**
 * Markdown editor with a live preview toggle. Images can be pasted or dropped;
 * they are downscaled in the browser first so a phone photo does not push a
 * 12 MB original through a mobile connection.
 */
export function MarkdownEditor({ value, onChange, placeholder, minHeight = 150, autoFocus, attachTo, onSubmit, fieldRef }: EditorProps) {
  const t = useT();
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = fieldRef ?? own;
  const [preview, setPreview] = useState(false);
  /** Where the caret belongs after the next render, set by `rewrite`. */
  const pending = useRef<[number, number] | null>(null);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const { workspaceId } = useSession();
  const members = useMembers();
  const toast = useToast();
  // The `@` menu: which handles match, and which of them is highlighted.
  const [mention, setMention] = useState<{ query: string; at: number; index: number } | null>(null);
  // ...and the `#` menu, which offers work rather than people.
  const [hash, setHash] = useState<{ query: string; at: number; index: number } | null>(null);

  const matches = mention
    ? members
      .filter((member) => `${member.name} ${member.email}`.toLowerCase().includes(mention.query.toLowerCase()))
      .slice(0, 6)
    : [];

  /**
   * What `#` offers: the projects and the tasks of this workspace.
   *
   * Both, in one menu, because from the writer's side they are the same act —
   * naming the thing being discussed — and asking somebody to remember two
   * prefixes for that is a way to have neither used. Projects first: there are
   * few of them and they are what a conversation is usually about.
   *
   * Scanned from the synced cache and only while the menu is open, so a
   * workspace with ten thousand tasks costs nothing until somebody types `#`.
   */
  const refMatches = useQuery(() => {
    if (!hash) return [] as RefChoice[];
    const query = hash.query.toLowerCase();
    const projects = list('project', (project) => project.workspace_id === workspaceId && !project.archived)
      .filter((project) => !query || `${project.key} ${project.name}`.toLowerCase().includes(query))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .slice(0, 3)
      .map((project): RefChoice => ({
        key: project.id,
        token: `#${project.key}`,
        icon: project.icon || '🚀',
        label: project.name ?? '',
        hint: project.key ?? '',
      }));
    const tasks = list('task', (task) => task.workspace_id === workspaceId && !task.archived && !!task.identifier)
      .filter((task) => !query || `${task.identifier} ${task.title}`.toLowerCase().includes(query))
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 6 - projects.length)
      .map((task): RefChoice => ({
        key: task.id,
        token: task.identifier as string,
        icon: '',
        label: task.title ?? '',
        hint: task.identifier as string,
      }));
    return [...projects, ...tasks];
  }, [hash?.query, workspaceId]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useLayoutEffect(() => {
    if (!pending.current) return;
    const [from, to] = pending.current;
    pending.current = null;
    const field = ref.current;
    field?.focus();
    field?.setSelectionRange(from, to);
  });

  /**
   * Change the text and say where the caret ends up.
   *
   * The caret is restored in a layout effect rather than on the next animation
   * frame, and that is not tidiness: a frame is long enough to type in. Somebody
   * holding Enter down through a checklist types the next character before the
   * frame arrives, and it lands at the *old* caret — which produced lists like
   * `- [ ] wo` with the `t` somewhere at the end. A layout effect runs in the
   * same commit as the text it belongs to, so there is no gap to type into.
   */
  const rewrite = (text: string, from: number, to = from) => {
    pending.current = [from, to];
    onChange(text);
  };

  const surround = (before: string, after: string) => {
    const field = ref.current;
    if (!field) return;
    const { selectionStart: start, selectionEnd: end } = field;
    const selected = value.slice(start, end);
    rewrite(
      `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`,
      start + before.length,
      start + before.length + selected.length,
    );
  };

  const apply = (edit: Edit) => rewrite(edit.text, edit.caret);

  const insert = (text: string) => {
    const field = ref.current;
    const at = field?.selectionStart ?? value.length;
    onChange(`${value.slice(0, at)}${text}${value.slice(at)}`);
  };

  /**
   * Notice an `@` being typed and offer the people in the workspace.
   *
   * Mentions have always resolved by first name, display name or email — the
   * writer simply had to know one. Offering them is the difference between a
   * feature people use and a feature people are told about.
   */
  const trackMention = (text: string, caret: number) => {
    const upto = text.slice(0, caret);
    // Only at a word boundary, so an email address in the middle of a
    // sentence does not open a menu.
    const found = upto.match(/(?:^|[\s(])@([\w.+-]*)$/);
    setMention(found ? { query: found[1], at: caret - found[1].length - 1, index: 0 } : null);
  };

  /** Replace the partial `@handle` with the chosen one. */
  const pickMention = (member: { name: string; email: string }) => {
    if (!mention) return;
    const field = ref.current;
    const caret = field?.selectionStart ?? value.length;
    // The handle people read back is the first name; `findMentions` accepts it.
    const handle = member.name.split(/\s+/)[0] || member.email.split('@')[0];
    setMention(null);
    rewrite(`${value.slice(0, mention.at)}@${handle} ${value.slice(caret)}`, mention.at + handle.length + 2);
  };

  /**
   * Notice a `#` being typed and offer the work it could mean.
   *
   * The same word-boundary rule as `@`: a `#` inside a word is somebody writing
   * a URL fragment or a C header, not asking for a menu. A markdown heading is
   * `# ` with a space, which cannot match here either.
   */
  const trackRef = (text: string, caret: number) => {
    const found = text.slice(0, caret).match(/(?:^|[\s(])#([\w-]*)$/);
    setHash(found ? { query: found[1], at: caret - found[1].length - 1, index: 0 } : null);
  };

  /**
   * Replace the partial `#...` with the reference itself.
   *
   * A task goes in as its bare identifier and a project as `#KEY` — the tokens
   * people already write by hand — rather than as a markdown link. They are
   * shorter to read in a chat line, they survive being quoted and edited, and
   * the renderer turns both into links anyway. Writing a link here would make
   * the message say something different from what was typed.
   */
  const pickRef = (choice: RefChoice) => {
    if (!hash) return;
    const field = ref.current;
    const caret = field?.selectionStart ?? value.length;
    setHash(null);
    rewrite(`${value.slice(0, hash.at)}${choice.token} ${value.slice(caret)}`, hash.at + choice.token.length + 1);
  };

  async function upload(files: File[]): Promise<void> {
    if (!files.length || !workspaceId) return;
    setBusy(true);
    try {
      for (const file of files) {
        const payload = file.type.startsWith('image/') ? await downscale(file) : file;
        const result = await api.upload(workspaceId, payload, file.name, attachTo);
        insert(file.type.startsWith('image/') ? `\n![${file.name}](${result.url})\n` : `\n[${file.name}](${result.url})\n`);
      }
    } catch (err) {
      toast(err instanceof Error ? t('editor.uploadFailedReason', { reason: err.message }) : t('editor.uploadFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`editor${dropping ? ' dropping' : ''}`}>
      <div className="editor-toolbar">
        {SNIPPETS.map((snippet) => (
          <button
            key={snippet.title} type="button" className={buttonVariants({ variant: 'ghost', size: 'sm' })} title={t(snippet.title)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => surround(snippet.wrap[0], snippet.wrap[1])}
          >
            {snippet.icon}
          </button>
        ))}
        <label className={buttonVariants({ variant: 'ghost', size: 'sm' })} title={t('editor.attachImage')} style={{ cursor: 'pointer' }}>
          <Icon name="image" size={14} />
          <input
            type="file" hidden multiple accept="image/*,application/pdf"
            onChange={(event) => {
              void upload([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </label>
        <span className="flex-1 min-w-0" />
        {busy && <span className="text-muted" style={{ fontSize: 12 }}>{t('editor.uploading')}</span>}
        <button type="button" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), preview && 'bg-active text-fg')} onClick={() => setPreview(!preview)}>
          {preview ? t('editor.write') : t('editor.preview')}
        </button>
      </div>

      {preview ? (
        <div className="md" style={{ minHeight, border: '1px solid var(--line-strong)', borderTop: 'none', borderRadius: '0 0 7px 7px', padding: 12 }}>
          <Markdown source={value || `_${t('editor.nothingToPreview')}_`} onChange={onChange} />
        </div>
      ) : (
        <>
        <textarea
          ref={ref}
          className="textarea"
          style={{ minHeight }}
          value={value}
          placeholder={placeholder ?? t('editor.placeholder')}
          onChange={(event) => {
            onChange(event.target.value);
            trackMention(event.target.value, event.target.selectionStart ?? 0);
            trackRef(event.target.value, event.target.selectionStart ?? 0);
          }}
          onBlur={() => setTimeout(() => {
            setMention(null);
            setHash(null);
          }, 120)}
          onKeyDown={(event) => {
            if (hash && refMatches.length) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setHash({ ...hash, index: (hash.index + step + refMatches.length) % refMatches.length });
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                pickRef(refMatches[hash.index]);
                return;
              }
              if (event.key === 'Escape') {
                setHash(null);
                return;
              }
            }
            if (mention && matches.length) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setMention({ ...mention, index: (mention.index + step + matches.length) % matches.length });
                return;
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                pickMention(matches[mention.index]);
                return;
              }
              if (event.key === 'Escape') {
                setMention(null);
                return;
              }
            }
            const field = ref.current;
            if ((event.metaKey || event.ctrlKey) && !event.altKey) {
              // The toolbar's three most-used buttons, where hands already are.
              const shortcut = { b: ['**', '**'], i: ['_', '_'], k: ['[', '](url)'] }[event.key.toLowerCase()];
              if (shortcut) {
                event.preventDefault();
                surround(shortcut[0], shortcut[1]);
                return;
              }
            }
            if (onSubmit && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
              return;
            }
            // Enter continues the list somebody is in — another bullet, the next
            // number, another empty checkbox — and ends it on an item they left
            // empty. Both are one pure rewrite of the text; see `editor.ts`.
            if (event.key === 'Enter' && !event.shiftKey && field && field.selectionStart === field.selectionEnd) {
              const edit = enterInList(value, field.selectionStart);
              if (edit) {
                event.preventDefault();
                apply(edit);
                return;
              }
            }
            if (event.key === 'Tab' && field) {
              event.preventDefault();
              // Inside a list, Tab is nesting. Everywhere else it stays an
              // indent, which is what somebody writing a code block wants.
              const edit = indentList(value, field.selectionStart, field.selectionEnd, event.shiftKey);
              if (edit) apply(edit);
              else if (!event.shiftKey) surround('  ', '');
            }
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length) {
              event.preventDefault();
              void upload(files);
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDropping(true);
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDropping(false);
            void upload([...event.dataTransfer.files]);
          }}
        />
        {hash && refMatches.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label={t('editor.mentionWork')}>
            {refMatches.map((choice, index) => (
              <button
                key={choice.key}
                type="button"
                role="option"
                aria-selected={index === hash.index}
                className={index === hash.index ? 'active' : ''}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickRef(choice)}
              >
                <span aria-hidden="true" style={{ width: 18, textAlign: 'center' }}>{choice.icon || '#'}</span>
                <span className="flex-1 min-w-0 truncate">{choice.label}</span>
                <span className="text-muted mono truncate" style={{ fontSize: 11 }}>{choice.hint}</span>
              </button>
            ))}
          </div>
        )}
        {mention && matches.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label={t('editor.mentionPeople')}>
            {matches.map((member, index) => (
              <button
                key={member.id}
                type="button"
                role="option"
                aria-selected={index === mention.index}
                className={index === mention.index ? 'active' : ''}
                // The menu closes on blur, and blur fires before click.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickMention(member)}
              >
                <Avatar user={member} size={18} />
                <span className="flex-1 min-w-0 truncate">{member.name}</span>
                <span className="text-muted truncate" style={{ fontSize: 11 }}>{member.email}</span>
              </button>
            ))}
          </div>
        )}
        </>
      )}
    </div>
  );
}

/**
 * Resize an image on the client. Keeps uploads small on mobile connections and
 * means the server never needs an image library.
 */
export async function downscale(file: File, maxSide = 2000, quality = 0.82): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 900_000) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return file;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}
