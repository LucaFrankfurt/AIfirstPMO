/**
 * A support line as the team or the assistant wrote it: tables, charts and
 * emphasis drawn, nothing fetched and nothing to click.
 *
 * The visitor's window and the team's inbox both draw these, and both used to
 * show every line as plain text. Tables and charts are what the support chat
 * was asked to show; images and links are what a stranger's words — or a
 * model's answer to them — must not bring, which is the renderer's `untrusted`
 * rule. Line breaks are kept, as they always were in a chat.
 *
 * Here, beside the thread, because the widget's page draws it too and must not
 * import the pages module and its editor to do it.
 */
import { useMemo } from 'react';
import { renderMarkdown } from '@kolibri/shared';

export function RichText({ source, tableLabel, locale }: { source: string; tableLabel: string; locale: string }) {
  const html = useMemo(
    () => ({ __html: renderMarkdown(source, { untrusted: true, breaks: true, chartTableLabel: tableLabel, locale }) }),
    [source, tableLabel, locale],
  );
  return <div className="md" dangerouslySetInnerHTML={html} />;
}
