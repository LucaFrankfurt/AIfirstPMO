// How a normalized FeedbackReport becomes a title + Markdown body at the target.
//
// Split out of the target so the formatting (pure, fully unit-testable) is separable
// from the transport. A second target that also wants Markdown reuses
// buildDescriptionMarkdown; one that wants something else writes its own and reuses
// only buildTitle.
//
// THIS OUTPUT IS NOT ESCAPED, AND THAT IS ONLY CORRECT FOR KOLIBRI. Kolibri's
// Markdown renderer escapes ALL input before it generates any markup and only ever
// emits a fixed set of tags — `<script>alert(1)</script>` comes back out as visible
// text (verified against a live instance, docs/setaside-feedback-api.md §B8 in this
// repository). Escaping here as well would double-escape, and the reporter would
// read `&lt;div&gt;` in their own report.
//
// A target whose sink renders raw HTML (or Markdown with HTML passthrough) MUST NOT
// reuse this body as-is: the reporter's free text and every client-reported value
// would be stored XSS in the team's own tracker.
//
// What is here instead is a LAYOUT control, deliberately not dressed up as a security
// one: fenceFor() and cell() stop a reporter's `#`, `**` or `|` from rearranging the
// ticket. If they fail, a report looks wrong. Nothing more.
import type { FeedbackFactValue, FeedbackReport } from './types.ts';
import { en, type FeedbackMessages } from './messages.ts';

export interface FormatOptions {
  /** Language of the labels. Default: German. */
  messages?: FeedbackMessages;
  /** Display labels for the app's own kinds; falls back to `messages.kinds`, then the raw kind. */
  kindLabels?: Readonly<Record<string, string>>;
  /** Keep the reported URL's query string and fragment. Default: false — they carry reset tokens, OAuth codes and e-mail addresses. */
  fullUrl?: boolean;
}

export function kindLabel(kind: string, options: FormatOptions = {}): string {
  const messages = options.messages ?? en;
  return options.kindLabels?.[kind] ?? messages.kinds[kind] ?? kind;
}

/** Collapse to a single line and cut to `max`, so a title can't carry a newline or run long. */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** A reported URL without its query string and fragment. */
function withoutQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return url.split(/[?#]/, 1)[0];
  }
}

/** The route part of a reported URL ("/companies/abc"; with `fullUrl`, "/companies/abc?x=1"), or "" if unparseable. */
export function routeOf(url: string | undefined, fullUrl = false): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return fullUrl ? `${u.pathname}${u.search}` : u.pathname;
  } catch {
    // A client-supplied string that isn't a URL. Keep it if it already looks like a
    // path (the common case for a relative report), else drop it rather than guess.
    const path = fullUrl ? url : withoutQuery(url);
    return path.startsWith('/') ? oneLine(path, 120) : '';
  }
}

/**
 * The task title: kind, route, and the first line of the message.
 *
 * Front-loaded with the things that make a list of tickets scannable — someone
 * triaging sees "what kind, where, what" without opening anything. The reporter's
 * name is deliberately NOT here (it is in the body): a title is a summary of the
 * problem, and a board of "Bug — Max Mustermann" reads as a list of people.
 */
export function buildTitle(report: FeedbackReport, options: FormatOptions = {}): string {
  const messages = options.messages ?? en;
  const kind = kindLabel(report.kind, options);
  const route = routeOf(typeof report.client?.url === 'string' ? report.client.url : undefined, options.fullUrl);
  const summary = oneLine(report.message, 80) || messages.report.untitled;
  return oneLine(route ? `[${kind}] ${route} — ${summary}` : `[${kind}] ${summary}`, 200);
}

/**
 * A fence long enough to survive the text it wraps.
 *
 * CommonMark's rule: a fenced block ends at a run of backticks at least as long as
 * the opening one, so an opener longer than anything inside cannot be closed early.
 * A reporter pasting a fenced code snippet into the feedback box is the case this
 * exists for — without it their ``` closes ours and the rest of the report renders as
 * markup.
 *
 * Kolibri's renderer is explicitly NOT CommonMark-conformant, so this rule was checked
 * against it rather than taken from the spec: the fence closes only on "a marker at
 * least as long as the one that opened it" (packages/shared/src/modules/pages/
 * markdown.ts), and a report carrying a fenced snippet was run
 * through that renderer end to end — both context tables intact, the snippet verbatim.
 */
export function fenceFor(text: string): string {
  const longest = [...text.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * One table cell.
 *
 * Two transformations, both structural: a newline would end the table row, and an
 * unescaped `|` would split one cell into two. `\|` is the escape Kolibri's table
 * parser honours (§B9). Nothing here is a security measure — see the file header.
 */
function cell(value: unknown): string {
  const v = value === null || value === undefined || value === '' ? '—' : String(value);
  return v.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|') || '—';
}

function table(rows: ReadonlyArray<readonly [string, unknown]>, messages: FeedbackMessages): string {
  return [
    `| ${messages.report.field} | ${messages.report.value} |`,
    '| --- | --- |',
    ...rows.map(([label, value]) => `| ${cell(label)} | ${cell(value)} |`),
  ].join('\n');
}

/**
 * The task description, as Markdown.
 *
 * Structured in three blocks, in this order and for this reason:
 *   1. the reporter's own words, first and unmangled — that is the actual report;
 *   2. SERVER-DERIVED context, which is trustworthy;
 *   3. CLIENT-REPORTED context, explicitly labelled as such.
 *
 * (2) and (3) are separate tables rather than one merged block precisely so nobody
 * reading the ticket has to remember which fields the browser was free to make up.
 *
 * The reporter's text sits in a fenced block rather than as running prose: a bug
 * report is frequently steps on separate lines, and a fence preserves them exactly
 * while also keeping a stray `#` or `**` from restyling the ticket. `text` as the
 * language tag means no highlighter tries to interpret it.
 */
export function buildDescriptionMarkdown(report: FeedbackReport, options: FormatOptions = {}): string {
  const messages = options.messages ?? en;
  const m = messages.report;
  const r = report.reporter;
  const c = report.client ?? {};
  const message = report.message.trim() || m.untitled;
  const fence = fenceFor(message);

  const name = r.name || '—';
  const serverRows: Array<readonly [string, FeedbackFactValue]> = [
    [m.reportedBy, r.role ? `${name} (${r.role})` : name],
    [m.userId, r.id],
    ...(report.serverContext ?? []),
    [m.reportedAtServer, report.createdAt.toISOString()],
    [m.reportId, report.id],
  ];

  const clientRows: Array<readonly [string, unknown]> = [
    [m.url, typeof c.url === 'string' && !options.fullUrl ? withoutQuery(c.url) : c.url],
    [m.pageTitle, c.title],
    [m.viewport, c.viewport],
    [m.screen, c.screen],
    [m.devicePixelRatio, c.devicePixelRatio],
    [m.userAgent, c.userAgent],
    [m.language, c.language],
    [m.timezone, c.timezone],
    [m.online, c.online === undefined ? undefined : c.online ? m.yes : m.no],
    [m.connection, c.connection],
    [m.clientTime, c.clientTime],
  ];

  const backlink = report.backlink?.url ? `[${report.backlink.label ?? m.openReport}](${report.backlink.url})` : '';

  return [
    `**${m.description}**`,
    `${fence}text\n${message}\n${fence}`,
    `**${m.serverContext}**`,
    table(serverRows, messages),
    `**${m.clientContext}**`,
    table(clientRows, messages),
    backlink,
  ]
    .filter(Boolean)
    .join('\n\n');
}
