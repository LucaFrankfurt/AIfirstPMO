/**
 * Delivery over Scaleway's Transactional Email API.
 *
 * The alternative to an SMTP relay, for the same reason the rest of this server
 * has no runtime dependencies: it is one HTTPS request with a JSON body, and a
 * provider SDK to make it would be larger than the server that sends it.
 *
 * Why offer it at all when SMTP already works — Scaleway's relay speaks SMTP
 * too. Because the API is the half that survives a hosting environment: plenty
 * of platforms block outbound 25/465/587 outright, and a request to port 443 is
 * the one thing that always gets out.
 *
 * Contract, as documented at
 * https://www.scaleway.com/en/developers/api/transactional-email/ —
 *
 *   POST {region url}/emails
 *   X-Auth-Token: <API secret key>
 *   { from: {email, name}, to: [{email, name}], subject, text, html,
 *     project_id, additional_headers: [{key, value}] }
 *
 * and the reply carries `emails: [{ id, message_id, status, … }]`.
 *
 * Two of its documented limits are worth knowing here, even though neither can
 * currently be hit: ten recipients per call, and 2 MB for the whole message
 * including attachments. Kolibri sends one recipient at a time and attaches
 * nothing, so both are headroom rather than constraints — noted so that
 * whoever adds attachments finds the number before their users do.
 *
 * The service runs in `fr-par` only, which is why the region is baked into the
 * default URL rather than assembled from a region name that has one legal
 * value.
 */
import { assertEmailAddress } from '../../kernel/mail/address.ts';
import { headerSafe, isHeaderName } from './headers.ts';
import { DeliveryError, type Deliverable } from './delivery.ts';

export interface ScalewayConfig {
  /** The full regional endpoint, ending in `/emails`. */
  url: string;
  /** An API secret key with the `TransactionalEmailFullAccess` permission. */
  secretKey: string;
  projectId: string;
  timeoutMs?: number;
}

interface SentEmail {
  id?: string;
  message_id?: string;
  status?: string;
}

export async function sendViaScaleway(config: ScalewayConfig, mail: Deliverable): Promise<string> {
  const headers: { key: string; value: string }[] = [];
  // `Reply-To` is a header here rather than a field: the API has no reply-to of
  // its own, and `additional_headers` is where it documents putting one.
  if (mail.replyTo) {
    headers.push({ key: 'Reply-To', value: assertEmailAddress(mail.replyTo, 'The reply-to address') });
  }
  for (const [key, value] of Object.entries(mail.headers ?? {})) {
    // Cleaned exactly as the SMTP path cleans them. It is tempting to skip
    // this because JSON has no line-oriented injection to worry about — but
    // these are copied into a real message at the far end, and the far end is
    // line-oriented again. The list-unsubscribe header this mostly carries is
    // built from a URL, and a URL is a fine place to hide a newline.
    if (value && isHeaderName(key)) headers.push({ key, value: headerSafe(value) });
  }

  const body = {
    from: {
      email: assertEmailAddress(mail.from, 'The sender address'),
      ...(mail.fromName ? { name: mail.fromName } : {}),
    },
    to: [{ email: assertEmailAddress(mail.to, 'The recipient address') }],
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
    project_id: config.projectId,
    ...(headers.length ? { additional_headers: headers } : {}),
  };

  const timeoutMs = config.timeoutMs ?? 20_000;
  // A queue worker that blocks forever on one message stops sending all of
  // them, and `fetch` has no timeout of its own.
  const abort = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': config.secretKey },
      body: JSON.stringify(body),
      signal: abort,
    });
  } catch (error) {
    // Never reached the provider: a DNS failure, a refused connection, the
    // timeout above. Nothing about the recipient is known, so this is a bad
    // moment and not a bad address.
    throw new DeliveryError(
      `Scaleway could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      false,
    );
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    /*
     * Which failures are worth retrying, in HTTP's terms rather than SMTP's.
     *
     * 4xx is the request itself being wrong — a bad key, a sender domain that
     * is not verified, a malformed address — and sending it again unchanged
     * gets the same answer. 5xx is Scaleway, and 429 is Scaleway asking for a
     * moment; both are what the backoff is for.
     *
     * Note this is the opposite way round from SMTP, where 5xx is the final
     * word and 4xx means try later. Getting it backwards would mean an outage
     * at the provider suppressing every address it touched — see the note on
     * `DeliveryError`.
     */
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new DeliveryError(
      `Scaleway refused the message (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      permanent,
    );
  }

  const result = await response.json().catch(() => null) as { emails?: SentEmail[] } | null;
  const sent = result?.emails?.[0];
  if (!sent) {
    // A 2xx with nothing in it is not a delivery. Retryable, because the shape
    // being wrong is more likely a bad minute at the API than a bad address —
    // and because the alternative is silently suppressing somebody over a
    // response nobody has read.
    throw new DeliveryError('Scaleway accepted the request but named no message', false);
  }

  // The `message_id` is the RFC 5322 Message-ID the recipient will see, which
  // is what the queue stores and what a bounce report is matched on. The `id`
  // is Scaleway's own handle, and is the one to quote at their support desk —
  // so it goes in the log line rather than being thrown away.
  return sent.message_id || sent.id || '';
}
