# Security

What this instance defends against, where each defence actually lives, and — the part most such
documents leave out — what has never been looked at.

Nothing here is a certification. Kolibri has not been audited by anybody outside this repository.
What it has had is three reviews written down as they happened, each of which found something real;
the findings are named below rather than summarised away, because a list of controls with no
failures in it is a list nobody tested.

## The threat model, in one paragraph

A self-hosted instance where **anybody may sign up** unless the operator turns that off, and where
signing up gets you a workspace of your own and the admin role inside it. That is the assumption
every rule below is written against. "An admin" is therefore not a trusted person — on an open
instance it is a stranger with a form — and a control that only protects one workspace from another
must hold even when the attacker owns a workspace.

The operator is trusted. Environment variables, the data volume and the container are outside this
model; if they are compromised, so is everything.

## Who may see what

Three questions, asked in this order, in `lib/auth.ts` and `lib/repo.ts`:

1. **Is there a session or a token?** Cookie sessions are `HttpOnly`, `SameSite=Lax`, and `Secure`
   whenever the request arrived over TLS — decided by `lib/origin.ts`, which is the single place
   that knows whether this instance is behind a proxy and what its public address is.
2. **Is this person a member of this workspace, at this role?** `requireWorkspace(ctx, id, role)`.
   Membership is checked before visibility, which sounds obvious and was the first review's finding:
   a "public" project is public *to that workspace*, and `canSeeProject` used to answer the
   visibility question without asking the membership one.
3. **Does the token carry the scope?** API and MCP tokens are `read` or `read,write`. A read-only
   token is refused by every write path, including all nine writing MCP tools.

A row may only reference rows in its own workspace. `parent_id`, `project_id`, `state_id` and the
rest are checked at the write in `guardReferences` — not because a dangling reference is dangerous
in itself, but because a shared page renders its children, and without the check anybody with an
account and a page id could publish their own text on a stranger's public share link, under the
stranger's workspace name.

## What reaches the outside

Two features hand this server a URL that somebody else chose: an **outgoing webhook**, whose address
a workspace admin types in, and a **Web Push subscription**, whose endpoint the browser supplies.
Both are also the classic way to make a server reach what the person asking cannot — the container
beside it, the database on the private network, the metadata service on `169.254.169.254`.

`lib/outbound.ts` is the only way out:

- scheme restricted to `http`/`https`; a URL with credentials in it is refused;
- the name is resolved **before** the connection and *every* address it answers with is checked;
- the socket is then **pinned** to the address that passed. Without pinning a name can answer
  publicly for the check and privately a moment later for the connection, and the check was theatre;
- redirects are followed by hand, three at most, re-checked at each hop and **without the original
  headers**, so a public URL that `302`s to the metadata service does not carry the signature or
  the VAPID token with it;
- loopback, RFC 1918, link-local, carrier-grade NAT, benchmarking, multicast and reserved ranges are
  refused, along with every way IPv6 has of spelling an IPv4 address — `::ffff:127.0.0.1`, NAT64,
  6to4.

`KOLIBRI_ALLOW_PRIVATE_WEBHOOKS=1` turns the check off, for the instance that genuinely posts to
`http://n8n:5678` on its own docker network. Off by default.

**A model, when somebody asks for one.** A task review (`docs/ai.md`) sends the project name, column,
labels, title and description of one task to whichever provider the operator configured. It is the
only feature that sends a workspace's own words to a third party, so it is gated twice — a key in
the environment *and* a switch a workspace admin sets — refused for guests and read-only tokens,
rate-limited per person, and never triggered by anything but a click. Assignees, dates, estimates,
comments and attachments are not sent. Nothing about the review is stored; what survives is whatever
somebody chose to apply, as an ordinary edit under their own name.

The provider URL comes from the environment rather than from a user, which is why it goes out
through plain `fetch` rather than `lib/outbound.ts`: those checks exist for an address somebody
typed into the app, and applying them here would refuse a gateway on the instance's own network,
which is a supported way to run this.

## What comes back in

**HTML.** `renderMarkdown` escapes everything before generating any markup and emits a fixed set of
tags, so there is no sanitiser to get wrong and no parser to confuse. `javascript:`, `data:` and
protocol-relative URLs are refused; external links carry `rel="noopener noreferrer"`. The
Content-Security-Policy (`lib/csp.ts`) is the second lock rather than the first: `default-src 'self'`,
no inline or `eval`'d script, `frame-ancestors 'none'`. It is computed rather than constant, because
a pre-signed download redirects the browser to the object store and that origin has to be named.

**SMTP.** An address with a carriage return in it is not a badly-typed address, it is a second
command to the relay. `lib/address.ts` refuses control characters, and it is called at the socket —
in `smtp.ts`, where `MAIL FROM` and `RCPT TO` are written — as well as at the form, because an
address can reach the queue from a form, an identity provider, a restored backup or an environment
variable and only one of those is a form. Header *names* are validated as well as their values.

**SQL.** Every value is a bound parameter. Table and column names *are* interpolated — and every one
of those interpolations reads a compile-time constant out of the `ENTITIES` registry, never a
request. `resolve()` in `routes/entities.ts` refuses any entity name not in `REST_ENTITIES`, so the
registry is the only vocabulary a URL can reach. Full-text search is
`WHERE search_index MATCH ? AND (workspace_id = ? OR workspace_id IS NULL)`.

**Uploads.** Auth, membership and write scope on the way in; membership on the way out. The filename
is stripped of `\r`, `\n`, `"`, `\` and `..`; the body is aborted at `KOLIBRI_MAX_UPLOAD_MB` while
streaming rather than after. Only a short list of types is served with its own content type and
`inline` — no SVG, no HTML — and `x-content-type-options: nosniff` is always set. On S3 the same
list decides the pre-signed URL's `response-content-type` and `response-content-disposition`, so an
uploaded SVG downloads from the bucket exactly as it downloads from disk.

## Rate limits

On the routes where guessing is the attack: signing in, registering, looking up an invite code,
opening a share link, posting to an intake form, dynamic client registration, the calendar feed, the
inbound webhook, the bounce endpoint, and the two places a session is asked to re-confirm its
password. Token buckets in memory; a refusal costs a token too, so hammering after a `429` does not
reset the clock.

Signing in is limited **per account as well as per address** — an address-only limit is blind to one
account being tried from a thousand machines. A code from an authenticator is checked inside that
same request, so it inherits the same allowance rather than needing one of its own.

Because `KOLIBRI_TRUST_PROXY` is on by default, the socket address is charged as well against a much
wider bucket, so an instance published without a proxy cannot have a client invent a fresh allowance
per request. That wider bucket carries every setting of the one it stands behind, including whether
refusals deepen.

**Changing a password and turning two-factor off** are limited per account. Both re-ask for the
current password, which is the point of them — and that check is a guessing surface the sign-in
form's limit does not cover: whoever holds a borrowed session cookie would otherwise work through a
list at whatever rate the machine allows, with two-factor going off as the reward. It is also the
one unbounded way to spend the process's CPU, because each check is scrypt on the single thread that
serves everybody.

The number of buckets is capped. An address is free to invent, so a flood from a new one each time
would otherwise grow that map until the process died — a limiter that answers a denial-of-service
attempt by exhausting its own memory has chosen the wrong loser. Buckets that have refilled to full
are dropped first, since they are indistinguishable from buckets that were never made; only if that
is not enough does anything still holding somebody back go, closest-to-full first, so an attacker's
own empty bucket is the last thing evicted rather than the first. Eviction is never a way out.

## Accounts

Passwords are scrypt with a per-user salt. TOTP is written against RFC 6238's published vectors, so
it agrees with the phone rather than with itself; recovery codes are stored hashed and are one use
each. Every secret is compared with `secretEquals`, which does not return early at the first
differing byte — `!==` answers "how much of this did you get right", which is a way to learn a
secret one byte at a time. Session and API tokens are 24 random bytes stored hashed, so there is
nothing there to guess at rather than a limit standing in front of the guessing. Sessions are listed in Settings and revocable one at a time. OIDC is authorization-code with
PKCE and nothing else — no implicit flow, no refresh tokens held here — and an address is taken from
the provider only when the provider marks it verified.

The MCP endpoint is an OAuth 2.1 authorization server: RFC 9728 protected-resource metadata, RFC
8414 authorization-server metadata whose `issuer` must match the URL it was fetched from, RFC 7591
dynamic client registration that returns every registered field, PKCE S256, rotating refresh tokens.

## What the reviews found

Written down because the findings are the evidence, and because each one is a shape worth
recognising again.

| Review | Finding | Shape |
|---|---|---|
| Authentication & authorization | `canSeeProject` answered the visibility question without asking the membership one — cross-workspace read, write and delete | A check that is correct in isolation, in the wrong order |
| Authentication & authorization | The session cookie was missing `Secure` behind a TLS-terminating proxy | One signal (is this connection secure) derived in two places |
| Uploads | `files` keyed by hash alone, so the second workspace to upload identical bytes got no row — and a 403 reading back its own file | Content-addressing that forgot content is not ownership |
| Uploads | `presignGet` always asked for `inline` with the uploader's content type, defeating the allowlist on S3 only | A rule enforced on one of two paths |
| Injection | Registration's email pattern allowed a trailing newline (`$` without `m`), and the invite form validated nothing — SMTP command injection through the instance's relay | A regex that reads as strict and is not |
| Injection | A row could reference a row in another workspace, and a public share published it | A missing check found by asking what a *public* surface renders |
| Injection | Outgoing webhooks and push endpoints went straight to `fetch` | SSRF, in the two places a URL is user-supplied |
| Deploy | The address validator refused `kolibri@localhost` — this project's own default sender | Validation that drifted from "is this safe" into "is this tidy" |

The last one is the most useful of the eight. It was introduced *by* a security fix, it broke a
working deployment, and the test suite stayed green because every test used an address invented for
the test rather than the one the project ships. There are now two guards against exactly that: the
SMTP suite runs against the shipped default, and a check reads the `KOLIBRI_MAIL_FROM` fallback out
of `env.ts` and out of every compose file and asserts the validator accepts each one.

**A validator is only as good as the values it is pointed at, and the values most likely to be
missed are the ones nobody types.**

## What has not been looked at

Stated plainly, because the sections above could otherwise read as a claim of completeness.

- **No external audit.** Nobody outside this repository has reviewed any of it.
- **No BITV or WCAG certification.** `check:a11y` and `check:contrast` measure specific things well;
  neither is an accreditation, and neither has been run past a person using a screen reader daily.
- **Denial of service beyond the rate-limited routes.** A large sync push, a deeply nested page tree
  or a pathological filter are bounded by nothing but the process.
- **The client's own storage.** The IndexedDB mirror is a full copy of the workspace on the device.
  Signing out clears it; a stolen unlocked laptop is outside this model.
- **Supply chain.** `npm audit` reports zero vulnerabilities across the tree, and the server has
  exactly one dependency (a workspace link), but nothing here pins by hash or verifies provenance.
  No package count here on purpose: it changes on every `npm install`, so a number would be stale
  before you read it — `npm audit` is the thing to run rather than a figure to trust.
- **Multi-tenancy at scale.** The isolation tests cover two workspaces and one attacker. They do not
  cover an instance with a thousand of each.

## Reporting something

Report it privately through [GitHub's advisory
form](https://github.com/LucaFrankfurt/AIfirstPMO/security/advisories/new), which is a channel that
is not a public tracker and does not need one to be invented in the title of an issue. If you would
rather open an issue, say in the title that it is exploitable and leave the details out of the body.
