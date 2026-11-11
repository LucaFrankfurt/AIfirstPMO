/**
 * The rules a chat widget lives by, in the one place both sides can read them.
 *
 * The server decides with these and the settings screen previews with them, so
 * a site the screen accepts is a site the server will let frame the widget.
 */
import type { Conversation, WidgetAssistant, WidgetIdentity } from '../../kernel/registry/types.ts';

export const WIDGET_IDENTITIES = ['signed', 'anonymous'] as const satisfies readonly WidgetIdentity[];

export const isWidgetIdentity = (value: unknown): value is WidgetIdentity =>
  (WIDGET_IDENTITIES as readonly unknown[]).includes(value);

export const WIDGET_ASSISTANTS = ['off', 'suggest', 'answer'] as const satisfies readonly WidgetAssistant[];

export const isWidgetAssistant = (value: unknown): value is WidgetAssistant =>
  (WIDGET_ASSISTANTS as readonly unknown[]).includes(value);

/** Long enough for a stack trace pasted by a customer, short enough to refuse a novel. */
export const SUPPORT_MESSAGE_MAX = 4000;

/** How long a "typing" signal lasts without being repeated. */
export const SUPPORT_TYPING_MS = 6000;

/** A site as people type it: an optional scheme, a host, an optional port, and anything after. */
const SITE = /^(?:(https?):\/\/)?([a-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#].*)?$/;

/**
 * The origin a typed site means, or null when it means none.
 *
 * People paste `example.com`, `https://example.com/` and
 * `https://example.com/shop?x=1` for the same thing; `frame-ancestors` wants
 * the origin. No wildcards: a pattern is a decision about sites nobody has
 * looked at yet, and the first audience here is a handful of exact domains.
 * `http` only for a machine on the desk, because a widget on a plain-http
 * production site would send its visitors' session over the wire in the clear.
 */
export function siteOrigin(typed: string): string | null {
  const raw = typed.trim().toLowerCase();
  if (!raw || raw.includes('*')) return null;
  const match = SITE.exec(raw);
  if (!match) return null;
  const [, scheme = 'https', host, port] = match;
  const local = host === 'localhost' || host === '127.0.0.1';
  if (scheme === 'http' && !local) return null;
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  const usual = scheme === 'https' ? '443' : '80';
  return `${scheme}://${host}${port && port !== usual ? `:${port}` : ''}`;
}

/** A list of typed sites as the distinct origins they mean, dropping what means nothing. */
export function cleanOrigins(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    const origin = typeof item === 'string' ? siteOrigin(item) : null;
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/** `#rrggbb` and nothing else: it ends up inside a style attribute on somebody else's site. */
export const isWidgetColor = (value: unknown): value is string =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

/** What to call a visitor when they gave no name. */
export function visitorLabel(conversation: Pick<Conversation, 'visitor_name' | 'visitor_email' | 'visitor_id'>): string {
  return conversation.visitor_name?.trim()
    || conversation.visitor_email?.trim()
    || `#${conversation.visitor_id.slice(0, 6)}`;
}

/** Whether the visitor wrote last and nobody has answered yet. */
export const awaitsReply = (conversation: Pick<Conversation, 'status' | 'last_author'>): boolean =>
  conversation.status === 'open' && conversation.last_author === 'visitor';

/** Whether the team has not yet seen the newest message. */
export const unreadByTeam = (conversation: Pick<Conversation, 'last_message_at' | 'last_author' | 'agent_read_at'>): boolean =>
  conversation.last_author === 'visitor'
  && !!conversation.last_message_at
  && (conversation.agent_read_at ?? 0) < conversation.last_message_at;

/**
 * The snippet a site owner pastes, for the settings screen and the docs.
 *
 * The widget and the token are read on the first click, not when the script
 * loads; the token function is called then too, so a signed widget nobody
 * opens costs the host's server nothing.
 */
export function widgetSnippet(publicUrl: string, widgetId: string, identity: WidgetIdentity): string {
  const base = publicUrl.replace(/\/+$/, '');
  const config = identity === 'signed'
    ? `window.kolibriChat = {\n    widget: '${widgetId}',\n    // Ask your own server for a token signed with this widget's secret.\n    token: () => fetch('/api/support-chat-token').then((r) => r.text()),\n  };`
    : `window.kolibriChat = { widget: '${widgetId}' };`;
  return `<script>\n  ${config}\n</script>\n<script src="${base}/widget.js" async></script>`;
}
