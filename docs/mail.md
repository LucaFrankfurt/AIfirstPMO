# Connected mailboxes

Shared inboxes — `support@`, `info@`, `admin@` — connected once, searchable from
one place and from an assistant.

Off by default. A workspace admin switches it on under **Settings → Workspace**,
and it is the switch with the most behind it: turning it on means this instance
holds a credential to somebody else's mail server and a copy of what is in it.
That is a decision about the company rather than about a screen, which is why
this document leads with what it does not do.

## Read-only, by construction rather than by promise

Nothing here sends, replies, deletes, moves or marks as read. There is no tool
for it, no endpoint for it, and no code path that would reach one.

The guarantee is not a rule somebody has to keep. The IMAP session selects a
folder with `EXAMINE` rather than `SELECT`, which puts the *server* in a mode
where it refuses to change a flag or expunge a message. A bug in this client
cannot mark somebody's inbox as read; a compromised instance cannot empty it.

That is the whole shape of the feature. An assistant that can search an inbox is
useful; one that can answer from it is a different product with a different
consent conversation, and it is not this one.

## What is copied, and what is not

| | |
|---|---|
| Headers, dates, recipients | copied, indexed |
| The text of the message | copied, indexed, truncated at 100 kB |
| Attachment names, types and sizes | copied, indexed |
| **Attachment bytes** | **not copied** — fetched from the mail server on demand |

The last line is the one that differs from how an attachment on a task works,
and it is deliberate twice over. The mail server already holds those bytes, so a
second copy is a second thing to back up. And an invoice PDF copied into this
database is a copy somebody has to remember to delete when they are asked to.

The text *is* copied, because search is what this exists for and a search that
opened four IMAP connections per query would not be one.

## Who may read a mailbox

Two settings, per mailbox:

| | |
|---|---|
| **Everybody in the workspace** | the ordinary shared inbox |
| **Only the people named** | exactly them. Nobody else, admins included |

The second half of that sentence is the decision. An owner can *reconfigure* a
restricted mailbox — it is their instance — but they do not silently read it,
and no read path carries an admin bypass. A rule with an exception for whoever
is senior enough is not a rule anybody can be told about, and "the founder can
read the tax inbox" is a sentence somebody should have to write down rather than
discover.

An admin who is not on a restricted mailbox's list cannot set its password,
test it, sync it or repoint its host either. Removing yourself from a mailbox
has to mean you are out of it, including out of the half that could aim it
somewhere you can read.

### An empty list means nobody

This is the one inversion in the codebase and it is worth stating plainly.

Everywhere else a `members` list that is empty means *everybody*: a channel with
no members is open, a cycle with no projects covers all of them. Here it means
**nobody**. An empty list elsewhere is a shorthand somebody chose; an empty list
here is what you get by removing the last person from a private inbox, and the
reading where that opens `admin@` to the whole company is not one to be
surprised by. `canReadMailbox` in `@kolibri/shared` is the one place it is
decided, and the rule is written in five spellings — that function, the sync
filter's SQL, `visibleMailboxes` for the mail routes, the same function again
behind every MCP tool, and a guard on the generic entity routes. All five are
tested against each other in `mailbox.test.ts`, because a rule with five
spellings is a rule with five chances to be wrong. It has been wrong once: the
guard on the generic route was the last of the five to be written, and until it
was, `GET /api/mailboxes/<id>` handed any member of the workspace the host, the
login name and the member list of a restricted inbox.

## The password

It is not a field on the mailbox row, and that is the point rather than an
implementation detail.

`password` is a `secret` in the entity registry, so the ordinary write path will
not accept one and the sync feed omits it — but it is not on the row at all: it
lives in `mailbox_credentials`, which no pull selects from. A column that is
never selected is a stronger statement than a column that is selected and then
stripped, and the day a new read path forgets, this one has nothing to forget.

It arrives through its own admin-only endpoint and is sealed with AES-256-GCM
under a key derived from the instance secret — which lives in `.secret` beside
the database rather than inside it. Not a vault: an operator with the data
directory has both halves, and for something self-hosted that is by design. What
it buys is the difference between "a leaked backup is a leaked backup" and "a
leaked backup is a leaked inbox".

The screen shows whether a password is set, never what it is.

## How the copy stays current

Polling, every five minutes per mailbox, one mailbox at a time.

**Not IDLE**, which IMAP offers and which would deliver mail the second it
arrives. The reason is the one that made Telegram long-poll rather than take a
webhook: a self-hosted instance behind NAT with a laptop lid that closes cannot
hold four TLS connections open for a week, and a feature that works only on a
server with an uptime is not the feature this product ships. Mail two minutes
late is mail.

**One at a time**, because four inboxes at one provider polled in parallel is
four simultaneous logins from one address, which is what a rate limiter is for.

A first pass reaches back `sync_days` — a year by default, `0` for everything —
in batches of five hundred, each of which commits. A ten-year archive therefore
fills up over a night and an interruption costs one batch rather than the lot.

A failure backs off — one minute, five, fifteen, an hour — and stays visible:
`last_error` and `last_status` are on the row and the settings screen shows
them. `last_sync_at` is deliberately *not* touched by a failure. It means "when
this copy was last known good", and a failing mailbox whose timestamp kept
advancing would look fresh while going stale, which is the exact confusion the
column exists to prevent.

## Disconnecting deletes the copy

Every other switch in this product hides rows and keeps them: a workspace that
turns budgets off finds its figures where it left them. Mail is the exception.

Switching the **feature** off hides the screens and makes MCP refuse to read.
Disconnecting a **mailbox** deletes its messages, its attachment list, its
search index and its stored password. Somebody who connected the wrong inbox
needs a way to make that true again, and "the rows are still there but hidden"
is not it. The mail itself is untouched on the server.

## Searching

One query across every mailbox the caller may read — which is the query a mail
client cannot run, because a mail client is pointed at one account at a time.
Omitting the mailbox list searches all of them rather than none.

The box takes a small dialect, in German and English together, because one inbox
holds both:

```
von:stripe seit:2024-01 rechnung
from:stripe since:2024-01 invoice
betreff:"Rechnung Nr" hat:anhang bis:31.12.2024
```

| prefix | also | means |
|---|---|---|
| `from:` | `von:`, `absender:` | sender address or display name, substring |
| `to:` | `an:`, `empfänger:` | any recipient, To or Cc |
| `subject:` | `betreff:` | subject only |
| `since:` | `seit:`, `ab:` | inclusive. A bare year or month works |
| `until:` | `bis:`, `vor:` | inclusive **to the end of that day** |
| `file:` | `datei:`, `anhang:` | attachment filename, substring |
| `mailbox:` | `postfach:`, `in:` | one address or id; repeatable |
| `has:attachment` | `hat:anhang` | only messages carrying a file |

`seit:2024` is the first of January and `bis:2024` is the thirty-first of
December — padding both the same way would ask for one day. `bis:2024-12-31` is
23:59 on that day, not midnight, which is a bad day to lose in this feature in
particular.

An unknown prefix is **not** an error, unlike in the task query language. There
the vocabulary is closed and a typo silently filtering everything away is worse
than a message; here the corpus is somebody else's prose, and `re:`, `fwd:` and
`http:` all appear in real subject lines. So an unknown prefix stays part of the
free text.

Words match the subject, the body **and the attachment names**. That last one is
what makes the feature work: `Rechnung_2024_08.pdf` is a stronger claim about a
message than anything in its subject line.

## Finding the documents

The question this was built for is "everything the accountant needs for 2024",
asked of four inboxes at once.

`find_documents` ranks messages by how likely each is to carry an invoice,
receipt, credit note, bank statement, VAT notice, payslip or donation receipt —
in German and English — and returns **the evidence for each**, not only a score.
It ranks; it does not decide.

That is the design and not a shortfall. What counts as tax-relevant is a
judgement about a business, it varies by jurisdiction and by year, and a regex
that decided it would be wrong in the expensive direction: a filter that quietly
drops an invoice is worse than no filter, because the person using it has
stopped looking. So no caller filters on the score, every hit carries its
reasons in prose, and the model or the person reads them.

The filename counts double, and the separators are folded to spaces first — `\b`
treats an underscore as a word character, so `Rechnung_2024_08.pdf` matched
nothing at all until it was, which is the shape of a bug that never throws: the
message still ranked, on its subject, one row lower.

## The numbers

`mail_stats` answers what a mail client cannot: volume per mailbox and per
month, who writes most and from which companies, what arrives on a weekday, and
how fast anybody answers.

Every figure is counted from the copy, which makes all of them **honest about a
window and unable to speak about the past**: a mailbox connected last week with
`sync_days: 30` can report a busy Tuesday and cannot report last year. So every
answer carries the window it actually covers, and the tools say so out loud —
an empty 2019 is as likely to mean "not fetched" as "nothing there".

Reply times are measured between an incoming message and the next message in the
same thread from the mailbox's own address, which means **only a mailbox that
polls a Sent folder can measure them at all**. One that reads INBOX alone has the
questions and not the answers, and it reports `measurable: false` rather than
the median of an empty set.

## Through MCP

Eight tools. Seven read; one writes, and it writes to Kolibri.

| | |
|---|---|
| `list_mailboxes` | what is connected, and how fresh each copy is |
| `search_mail` | one search across every readable mailbox |
| `get_mail` | one message in full |
| `mail_thread` | the conversation, across every mailbox it touched |
| `find_documents` | the ranked document hunt, with its reasons |
| `list_mail_attachments` | files across the mailboxes, as one flat list |
| `mail_stats` | the numbers, with the window they cover |
| `file_mail_as_task` | the message becomes work, in a project |

There is a `tax_documents` prompt that runs the whole hunt: it lists the
mailboxes and how far back each has been polled *first*, so the answer can tell
"nothing was sent" from "nothing was fetched", then ranks, then reads the top
candidates rather than trusting the ranking.

Every one of them resolves the readable mailboxes first and constrains on that
list. None takes a mailbox id and trusts it. An empty list finds nothing rather
than everything, which is the property the whole design rests on: a reader that
forgets gets no rows instead of all of them.

## Connecting one

**Settings → Mailboxes**, as a workspace owner or admin, with the feature on.

1. Type the address. The host is guessed as `imap.<domain>`, which is right for
   most providers and wrong in a way the Test button shows immediately.
2. Check host, port and encryption. `tls` on 993 is the ordinary case;
   `starttls` on 143 is **required, not attempted** — a server that does not
   offer the upgrade is refused rather than talked to in the clear.
3. Set the password. Most providers with two-factor need an app password rather
   than the account one.
4. Press **Test connection**. It signs in, selects INBOX and hangs up, and shows
   the provider's own words when it cannot — `AUTHENTICATIONFAILED` and
   `application password required` are two different afternoons.
5. Choose who may read it, and how far back the first pass should reach.

## What it is not

- **Not a mail client.** No compose, no reply, no folders, no unread badge.
- **Not a mail server.** Kolibri does not receive mail; it reads somebody
  else's mailbox. Incoming mail that should *become* something is a webhook or
  an intake form — see [webhooks](api.md) and the intake queue.
- **Not archival.** The copy is a search index with the text alongside it. It
  goes when the mailbox is disconnected, and it does not claim to be a record.
- **Not OAuth.** Gmail and Microsoft accounts connect with an app password
  today. XOAUTH2 is a real gap and it is in [TODO.md](../TODO.md).
- **Not encrypted mail.** A PGP or S/MIME message is stored and indexed as
  whatever its outer part says, which for an encrypted body is nothing useful.
