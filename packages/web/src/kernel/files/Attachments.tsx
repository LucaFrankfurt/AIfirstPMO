/**
 * The Files section, for anything that has one.
 *
 * It was eighteen lines inside `TaskDetail.tsx` and it is a component because
 * the paperclip stopped belonging to tasks. A page, a decision, a project, a
 * budget, a KPI, a cycle, a module, a product and a component all carry files
 * now, and nine copies of "pick a file, upload it, list what is there" would
 * have been nine chances to disagree about what happens when one fails.
 *
 * In the kernel rather than in `work`, for the reason `uploads.ts` beside it
 * is: a capability importing another capability's task sheet to get a file
 * picker is the coupling `CLAUDE.md` says to fix by moving the shared thing
 * down. Nothing here knows what a task is — it is handed a subject.
 *
 * Two things it deliberately does **not** do:
 *
 * - **It does not delete the bytes.** Storage is content-addressed and shared,
 *   so the same screenshot on two tasks is one blob with two rows; removing the
 *   blob would take the file out from under the other one. This writes the
 *   tombstone on the attachment, which is what `delete_attachment` over MCP
 *   does and what the trash can restore.
 * - **It does not wait for the server.** `remove` is the ordinary offline-first
 *   mutation, so the row leaves the list at once and the outbox carries the
 *   delete whenever there is a network. A file deleted on a train is deleted.
 */
import { useRef, useState } from 'react';
import { attachmentSubject, type Attachment } from '@kolibri/shared';
import { Icon, useConfirm, useLightbox } from '../design-system/ui';
import { Button } from '../design-system/ui/button';
import { useT } from '../i18n/i18n';
import { useCanWrite } from '../identity/session';
import { remove } from '../sync/mutations';
import { list, useQuery } from '../sync/store';
import { useUploads, type AttachTo } from './uploads';

/** Rounded up, because a 300-byte file is not "0 KB". */
const kb = (size: number | null | undefined): number => Math.max(1, Math.round((size ?? 0) / 1024));

/**
 * What is attached to this one thing.
 *
 * Matched through `attachmentSubject` rather than against a column, so a screen
 * asking for a decision's files does not have to know that a task's link is
 * `task_id` and a decision's is the `subject_kind` pair. A row this build cannot
 * name answers `null` and is left out, which matches what the server will send:
 * the pull filter does not mirror one either.
 */
export function useAttachments(on: AttachTo): Attachment[] {
  return useQuery(
    () => list('attachment', (row) => {
      const subject = attachmentSubject(row);
      return subject?.kind === on.kind && subject.id === on.id;
    }).sort((a, b) => a.created_at - b.created_at),
    [on.kind, on.id],
  );
}

export function Attachments({ on, heading, empty, className }: {
  on: AttachTo;
  /** What to call the section. Defaults to "Files". */
  heading?: string;
  /** What to say when there are none. Defaults to "No files yet." */
  empty?: string;
  className?: string;
}) {
  const t = useT();
  const canWrite = useCanWrite();
  const files = useAttachments(on);
  const { busy, take } = useUploads(on);
  const { confirm, dialog } = useConfirm();
  const { open: zoom, lightbox: viewer } = useLightbox();
  const picker = useRef<HTMLInputElement>(null);
  /*
   * Whether something is being dragged over this section.
   *
   * A counter and not a boolean. `dragleave` fires when the pointer crosses
   * into a *child* of the drop zone, so a boolean flickered off the moment the
   * cursor touched a file row and the highlight strobed its way across the
   * list. Counting enter against leave is the standard fix and the only one
   * that survives nested children.
   */
  const [dragging, setDragging] = useState(0);

  const upload = async (picked: File[]): Promise<void> => {
    if (picked.length) await take(picked);
  };

  return (
    <section className={className}>
      <div className="flex items-center gap-2 mb-1.5">
        <strong className="text-[13.5px]">{heading ?? t('attachment.files')}</strong>
        {files.length > 0 && <span className="text-muted text-[12.5px]">{files.length}</span>}
        <span className="flex-1 min-w-0" />
        {canWrite && (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => picker.current?.click()}>
              <Icon name="attach" size={14} /> {busy ? t('attachment.uploading') : t('attachment.attach')}
            </Button>
            <input
              ref={picker} type="file" hidden multiple
              onChange={(event) => {
                void upload([...(event.target.files ?? [])]);
                // Cleared so picking the same file twice in a row still fires a
                // change event the second time.
                event.target.value = '';
              }}
            />
          </>
        )}
      </div>

      {/* The drop zone is the list, so a file can be dropped onto the files
          that are already there — which is where somebody aims. It is only a
          drop zone for people who may write; dragging a PDF onto a read-only
          screen should do what dragging it onto any other page does. */}
      <div
        className={dragging > 0 ? 'attachment-list dropping' : 'attachment-list'}
        onDragEnter={canWrite ? (event) => { event.preventDefault(); setDragging((n) => n + 1); } : undefined}
        onDragLeave={canWrite ? () => setDragging((n) => Math.max(0, n - 1)) : undefined}
        onDragOver={canWrite ? (event) => { event.preventDefault(); } : undefined}
        onDrop={canWrite ? (event) => {
          event.preventDefault();
          setDragging(0);
          void upload([...(event.dataTransfer?.files ?? [])]);
        } : undefined}
      >
        {files.length === 0 && (
          <span className="text-muted text-[12.5px]">
            {empty ?? (canWrite ? t('attachment.noneYet') : t('attachment.none'))}
          </span>
        )}
        {files.map((file) => (
          <div className="attachment" key={file.id}>
            {file.mime?.startsWith('image/')
              ? (
                /* Opened in place rather than in a tab: a screenshot is being
                   looked at, not downloaded, and the lightbox is what every
                   other image in this application does. */
                <button type="button" className="attachment-thumb" aria-label={file.name} onClick={zoom}>
                  {/* `alt` carries the name because `useLightbox` reads the
                      clicked `img` and labels the overlay with it — an empty
                      alt here would open an unnamed picture. */}
                  <img src={file.url} alt={file.name} />
                </button>
              )
              : <Icon name="page" />}
            <a className="flex-1 min-w-0 truncate" href={file.url} target="_blank" rel="noreferrer">{file.name}</a>
            <span className="text-muted">{t('attachment.kb', { size: kb(file.size) })}</span>
            {canWrite && (
              <Button
                variant="ghost" size="iconSm" aria-label={t('attachment.remove')}
                onClick={async () => {
                  if (await confirm(t('attachment.removeConfirm', { name: file.name }), t('attachment.remove'))) {
                    remove('attachment', file.id);
                  }
                }}
              >
                <Icon name="trash" size={13} />
              </Button>
            )}
          </div>
        ))}
      </div>
      {viewer}
      {dialog}
    </section>
  );
}
