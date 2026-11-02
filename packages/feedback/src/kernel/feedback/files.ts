// Screenshot file naming, shared by the browser (which names the upload) and the
// delivery side (which names the attachment at the target) so the two cannot drift.

/** The image types the capture produces and the server accepts. */
export const SCREENSHOT_MIME_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;

/** File extension matching a produced MIME. PNG is the fallback — it is what a canvas emits when asked for a type it cannot encode. */
export function extensionFor(mime: string): string {
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg') return 'jpg';
  return 'png';
}

/** "screenshot.webp" etc. */
export function screenshotFilename(mime: string): string {
  return `screenshot.${extensionFor(mime)}`;
}
