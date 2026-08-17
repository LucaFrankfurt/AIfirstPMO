import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { api } from '../lib/api';
import { useSession } from '../session';
import { Icon, useToast } from './ui';

export function Markdown({ source, className = '' }: { source?: string | null; className?: string }) {
  const html = useMemo(() => renderMarkdown(source ?? ''), [source]);
  if (!source?.trim()) return null;
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
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
}

const SNIPPETS: { icon: string; title: string; wrap: [string, string] }[] = [
  { icon: 'B', title: 'Bold', wrap: ['**', '**'] },
  { icon: 'I', title: 'Italic', wrap: ['_', '_'] },
  { icon: '</>', title: 'Code', wrap: ['`', '`'] },
  { icon: '#', title: 'Heading', wrap: ['## ', ''] },
  { icon: '•', title: 'Bullet list', wrap: ['- ', ''] },
  { icon: '☑', title: 'Checklist', wrap: ['- [ ] ', ''] },
  { icon: '❝', title: 'Quote', wrap: ['> ', ''] },
];

/**
 * Markdown editor with a live preview toggle. Images can be pasted or dropped;
 * they are downscaled in the browser first so a phone photo does not push a
 * 12 MB original through a mobile connection.
 */
export function MarkdownEditor({ value, onChange, placeholder, minHeight = 150, autoFocus, attachTo, onSubmit }: EditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);
  const { workspaceId } = useSession();
  const toast = useToast();

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const surround = (before: string, after: string) => {
    const field = ref.current;
    if (!field) return;
    const { selectionStart: start, selectionEnd: end } = field;
    const selected = value.slice(start, end);
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const insert = (text: string) => {
    const field = ref.current;
    const at = field?.selectionStart ?? value.length;
    onChange(`${value.slice(0, at)}${text}${value.slice(at)}`);
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
      toast(err instanceof Error ? `Upload failed: ${err.message}` : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`editor${dropping ? ' dropping' : ''}`}>
      <div className="editor-toolbar">
        {SNIPPETS.map((snippet) => (
          <button
            key={snippet.title} type="button" className="btn ghost sm" title={snippet.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => surround(snippet.wrap[0], snippet.wrap[1])}
          >
            {snippet.icon}
          </button>
        ))}
        <label className="btn ghost sm" title="Attach image" style={{ cursor: 'pointer' }}>
          <Icon name="image" size={14} />
          <input
            type="file" hidden multiple accept="image/*,application/pdf"
            onChange={(event) => {
              void upload([...(event.target.files ?? [])]);
              event.target.value = '';
            }}
          />
        </label>
        <span className="grow" />
        {busy && <span className="muted" style={{ fontSize: 12 }}>Uploading…</span>}
        <button type="button" className={`btn ghost sm${preview ? ' active' : ''}`} onClick={() => setPreview(!preview)}>
          {preview ? 'Write' : 'Preview'}
        </button>
      </div>

      {preview ? (
        <div className="md" style={{ minHeight, border: '1px solid var(--line-strong)', borderTop: 'none', borderRadius: '0 0 7px 7px', padding: 12 }}>
          <Markdown source={value || '_Nothing to preview yet._'} />
        </div>
      ) : (
        <textarea
          ref={ref}
          className="textarea"
          style={{ minHeight }}
          value={value}
          placeholder={placeholder ?? 'Write in markdown…'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (onSubmit && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
            if (event.key === 'Tab') {
              event.preventDefault();
              surround('  ', '');
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
