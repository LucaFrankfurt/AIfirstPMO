/**
 * The rules a chat widget lives by, in the one place both sides can read them.
 *
 * The server decides with these and the settings screen previews with them, so
 * a site the screen accepts is a site the server will let frame the widget.
 */
import type { Conversation, WidgetAssistant, WidgetContextField, WidgetIdentity } from '../../kernel/registry/types.ts';

export const WIDGET_IDENTITIES = ['signed', 'anonymous'] as const satisfies readonly WidgetIdentity[];

export const isWidgetIdentity = (value: unknown): value is WidgetIdentity =>
  (WIDGET_IDENTITIES as readonly unknown[]).includes(value);

export const WIDGET_ASSISTANTS = ['off', 'suggest', 'answer'] as const satisfies readonly WidgetAssistant[];

export const isWidgetAssistant = (value: unknown): value is WidgetAssistant =>
  (WIDGET_ASSISTANTS as readonly unknown[]).includes(value);

/**
 * The facts about a visitor a widget may take from the host's token.
 *
 * Few and short on purpose: they are a plan, a status, a date — what a model
 * needs to answer "which plan am I on" — not a record. A value longer than
 * this is dropped rather than cut, because half an address is a wrong one.
 *
 * A field an admin marks long is the one exception: a summary the host wrote
 * for the model — an account's last weeks, its open orders — which a model can
 * answer "how did my month go" from and no 200 characters can hold. Up to one
 * knowledge page's length, and two of them at most, so that what a token adds
 * to the prompt stays smaller than the knowledge it sits beside.
 */
export const CONTEXT_FIELDS_MAX = 20;
export const CONTEXT_VALUE_MAX = 200;
export const CONTEXT_LONG_VALUE_MAX = 8_000;
export const CONTEXT_LONG_FIELDS_MAX = 2;
const CONTEXT_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** How a line of the settings form marks a field long: `briefing: Briefing [long]`. */
const LONG_MARK = /\s*\[long\]\s*$/i;

/**
 * A widget's allowed fields, from what an admin typed or a tool sent.
 *
 * Either a list of `{ key, label, long? }` or lines of `key: Label`, with
 * `[long]` at the end of a line for a long one — the form is a text box, like
 * the allowed sites. A key the token can carry is lowercase letters, digits and
 * underscores; a line that is not one is dropped, and so is a key named twice
 * and a long field past the second.
 */
export function cleanContextFields(value: unknown): WidgetContextField[] {
  const entries: unknown[] = typeof value === 'string' ? value.split('\n') : Array.isArray(value) ? value : [];
  const out: WidgetContextField[] = [];
  for (const entry of entries) {
    let key = '';
    let label = '';
    let long = false;
    if (typeof entry === 'string') {
      long = LONG_MARK.test(entry);
      const [head, ...rest] = entry.replace(LONG_MARK, '').split(':');
      key = head.trim();
      label = rest.join(':').trim();
    } else if (entry && typeof entry === 'object') {
      key = String((entry as Record<string, unknown>).key ?? '').trim();
      label = String((entry as Record<string, unknown>).label ?? '').trim();
      long = (entry as Record<string, unknown>).long === true;
    }
    if (!CONTEXT_KEY.test(key) || out.some((field) => field.key === key)) continue;
    if (long && out.filter((field) => field.long).length === CONTEXT_LONG_FIELDS_MAX) continue;
    // `long` only where it is true, so a short field is stored as it always was.
    out.push({ key, label: (label || key).slice(0, 60), ...(long ? { long: true } : {}) });
    if (out.length === CONTEXT_FIELDS_MAX) break;
  }
  return out;
}

/** The fields as the settings form shows them: one `key: Label` a line, `[long]` after a long one. */
export const contextFieldsText = (fields: WidgetContextField[] | undefined): string =>
  (fields ?? []).map((field) =>
    `${field.label === field.key ? field.key : `${field.key}: ${field.label}`}${field.long ? ' [long]' : ''}`).join('\n');

/**
 * What a signed token's `ctx` claim says about the visitor, kept to the
 * widget's fields: a string, a number or a yes/no each, nothing nested.
 *
 * Everything else is dropped without a word. The host chooses what to send and
 * the admin what to keep; a claim nobody allowed is the host sending more than
 * this widget was set up for, and keeping it would put it in front of a model.
 */
export function pickContext(raw: unknown, fields: WidgetContextField[]): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const { key, long } of fields) {
    const value = (raw as Record<string, unknown>)[key];
    const max = long ? CONTEXT_LONG_VALUE_MAX : CONTEXT_VALUE_MAX;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    if (typeof value === 'string' && value.trim() && value.trim().length <= max) out[key] = value.trim();
  }
  return out;
}

/** Long enough for a stack trace pasted by a customer, short enough to refuse a novel. */
export const SUPPORT_MESSAGE_MAX = 4000;

/** How long a "typing" signal lasts without being repeated. */
export const SUPPORT_TYPING_MS = 6000;

/** A site as people type it: an optional scheme, a host (perhaps `*.` and a domain), an optional port, and anything after. */
const SITE = /^(?:(https?):\/\/)?((?:\*\.)?[a-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#].*)?$/;

/**
 * The origin a typed site means, or null when it means none.
 *
 * People paste `example.com`, `https://example.com/` and
 * `https://example.com/shop?x=1` for the same thing; `frame-ancestors` wants
 * the origin. `http` only for a machine on the desk, because a widget on a
 * plain-http production site would send its visitors' session over the wire in
 * the clear.
 *
 * One kind of pattern: `*.example.com`, every subdomain of a domain, for a
 * platform whose customers each have one. `frame-ancestors` reads it the same
 * way — any depth of subdomain, never the domain itself, so `example.com` is
 * listed on its own if it is meant too. `https` only, and never `*.localhost`
 * or a bare `*.com`: a pattern is a decision about sites nobody has looked at
 * yet, and the narrowest one that says what is meant is the one to keep.
 */
export function siteOrigin(typed: string): string | null {
  const raw = typed.trim().toLowerCase();
  if (!raw) return null;
  const match = SITE.exec(raw);
  if (!match) return null;
  const [, scheme = 'https', host, port] = match;
  const wild = host.startsWith('*.');
  const name = wild ? host.slice(2) : host;
  const local = name === 'localhost' || name === '127.0.0.1';
  if (scheme === 'http' && (!local || wild)) return null;
  if (wild && local) return null;
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) return null;
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
export function widgetSnippet(publicUrl: string, widgetId: string, identity: WidgetIdentity, color?: string | null): string {
  const base = publicUrl.replace(/\/+$/, '');
  // The button is drawn before anything is asked of the instance, so the
  // widget's colour has to be in the page already — or the button is the
  // default purple under a window in the site's red.
  const tint = color && isWidgetColor(color) ? `\n    color: '${color}',` : '';
  const config = identity === 'signed'
    ? `window.kolibriChat = {\n    widget: '${widgetId}',${tint}\n    // Ask your own server for a token signed with this widget's secret.\n    token: () => fetch('/api/support-chat-token').then((r) => r.text()),\n  };`
    : tint ? `window.kolibriChat = {\n    widget: '${widgetId}',${tint}\n  };` : `window.kolibriChat = { widget: '${widgetId}' };`;
  return `<script>\n  ${config}\n</script>\n<script src="${base}/widget.js" async></script>`;
}
