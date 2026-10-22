/**
 * Putting a file into the workspace, and saying what it hangs on.
 *
 * This was two exported functions in `modules/pages/Markdown.tsx`, which is
 * where the first caller happened to be. Three modules imported them from
 * there — `work` for a task's Files section, `pages` for both editors — and
 * then the Files section stopped being a thing only a task has: a decision, a
 * budget and a component carry one too, and a capability importing another
 * capability's editor to upload a PDF is the shape `CLAUDE.md` says to move
 * down rather than rearrange. So it is down here, in the kernel, where anything
 * may reach it and it may reach nothing above itself.
 *
 * Nothing about the behaviour changed in the move. `downscale` is still the
 * reason the server needs no image library, and `useUploads` still returns
 * whatever succeeded when a later file fails.
 */
import { useState } from 'react';
import { uploadLink, type AttachTo } from './link';
import { api } from '../sync/api';
import { useSession } from '../identity/session';
import { useT } from '../i18n/i18n';
import { useToast } from '../design-system/ui';

/**
 * Shared by every editor and every Files section, which need the same three
 * things — downscale a photograph so a phone does not push twelve megabytes
 * through a mobile connection, upload it against whatever it belongs to, and
 * say so when it fails — and differ only in what they do afterwards.
 * Whatever succeeded is returned even when a later file fails, because losing
 * four uploads to the fifth one's timeout is worse than an incomplete paste.
 */
export { uploadLink, type AttachTo } from './link';

export function useUploads(attachTo?: AttachTo | null): {
  busy: boolean;
  take: (files: File[]) => Promise<{ url: string; name: string; image: boolean }[]>;
} {
  const t = useT();
  const toast = useToast();
  const { workspaceId } = useSession();
  const [busy, setBusy] = useState(false);

  const take = async (files: File[]) => {
    const done: { url: string; name: string; image: boolean }[] = [];
    if (!files.length || !workspaceId) return done;
    setBusy(true);
    try {
      for (const file of files) {
        const image = file.type.startsWith('image/');
        const result = await api.upload(
          workspaceId, image ? await downscale(file) : file, file.name, uploadLink(attachTo),
        );
        done.push({ url: result.url, name: file.name, image });
      }
    } catch (err) {
      toast(err instanceof Error ? t('editor.uploadFailedReason', { reason: err.message }) : t('editor.uploadFailed'));
    } finally {
      setBusy(false);
    }
    return done;
  };

  return { busy, take };
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
