/**
 * Where an upload is going, in the endpoint's own spelling.
 *
 * Its own file, with nothing React in it, because it is the one piece of the
 * attachment machinery worth testing directly and the web suite loads `.ts`
 * only — `uploads.ts` next door reaches for `useToast`, which lives in a
 * `.tsx`. The split is the same one `reaction-set.ts` makes beside
 * `reactions.tsx`, for the same reason.
 */
import { attachmentLink, type AttachmentSubject } from '@kolibri/shared';

/**
 * What an upload is being hung on.
 *
 * One subject, as a kind and an id, because that is what an attachment row
 * holds — and `attachmentLink` in `@kolibri/shared` is what turns it into
 * columns, so no screen has to know that a task has one of its own and a
 * decision does not.
 */
export type AttachTo = { kind: AttachmentSubject; id: string };

/**
 * The link as `POST /api/workspaces/:ws/files` takes it.
 *
 * `subject_kind` is the column and `subject` is the query parameter, which is
 * the one place the two names deliberately differ: `?subject=decision` reads as
 * a sentence and `?subject_kind=decision` reads as a schema. This line is the
 * only translation, and `attachment-link.test.ts` is what keeps it from
 * becoming two.
 */
export const uploadLink = (to?: AttachTo | null): Record<string, string> | undefined => {
  if (!to) return undefined;
  const { subject_kind: kind, ...rest } = attachmentLink(to.kind, to.id);
  return kind ? { ...rest, subject: kind } : rest;
};
