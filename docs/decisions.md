# Decisions

A question with options on it: which of these three, by Friday, and who said
what. Off by default; switched on per workspace under **Settings → Workspace**.

The shape is the KPI's and the budget's, deliberately: a definition, the rows
that happened against it, and one pure function that compares them. What is
different is that the rows here are *people*, and that changes two things — who
may see them, and what the count means.

## The shape of it

| | |
|---|---|
| **Decision** | The question. How many options may be held, whether the ballot is secret, when it closes, and where it is taken |
| **Option** | One thing that can be chosen. Its own row, so two people adding two options from two devices end up with both |
| **Vote** | One person's choice of one option. A row per option rather than a list per person, so two ticks in a multiple-choice ballot merge instead of overwriting each other |

A vote's id is derived from the three ids it names — `decision.option.voter` —
which is what makes casting the same vote from a phone and a laptop while both
are offline write one row instead of two that both count. Withdrawing is then a
tombstone on a known id, so a client never has to find the row first.

## Closed is decided on reading, not by a clock

`status` is what somebody set and `closes_at` is what they promised. Nothing
runs when the deadline passes: `isOpen` combines the two, and it is the only
place that does.

A scheduled job that flipped the column instead would need a workspace's
timezone to decide what "Friday" meant, would not have run on an instance that
was switched off over the weekend, and would leave two sources for one fact. So
a vote past its deadline reports as **expired** rather than as closed — which
is a different sentence and worth keeping: nobody decided it was over, the
clock did.

Reopening a vote the clock closed clears the deadline. Otherwise it reopens for
exactly as long as it takes to read the answer back.

## A secret ballot is secret at the pull

Anonymity here is not a column the screens agree to hide. It is a clause in the
sync filter: **a secret ballot's votes are sent to the voter and to nobody
else**, the way a rate is sent only to owners and admins.

That is the whole of the difference between this and a checkbox. Hiding the
names in the interface would leave every vote in every member's IndexedDB and
coming back from the REST collection — a secret ballot's user interface, over
an open ballot's data.

The price is that a device holding a secret ballot has nothing to count. So the
count comes from two figures the write path maintains inside the transaction
that changes a vote:

| | |
|---|---|
| `decision.voters` | People with at least one live vote. The denominator of every share |
| `option.tally` | Live votes for that option |

Both are **recounted, never adjusted**. Incrementing would have been cheaper and
would drift the first time a vote arrived twice from two devices — which is the
ordinary case here, not the exotic one, because the id is derived and sync
replays.

`tallyOf` in `@kolibri/shared` is the single place that decides which figures to
read, and `visibility` is the whole of the condition. An open ballot counts the
rows, which is exact and moves the instant somebody clicks, offline included. A
secret one reads the counters, which are as old as the last pull — and the
screen says so under the bars rather than leaving somebody to wonder why their
own vote did not move anything.

**What it does not promise.** An operator can read the database. `decision_votes`
holds a voter id and an option id in plain columns, so a secret ballot is secret
from the other people in the workspace, not from whoever runs the server. That
is the same boundary [`secrets.md`](secrets.md) draws, and it is worth knowing
before a workspace uses one for something a person could be punished for.

## The share is of the people, not of the ticks

Three of four voters tick both options in a multiple-choice ballot: six ticks,
four voters. "75% want A" is a sentence somebody can act on; "50% of the ticks"
is not, and it under-reports an option three quarters of the room asked for.

So every share is over `voters`. In a single-choice ballot the two are the same
number, so nothing has to be explained twice.

## A tie is a finding, not a rounding error

`leading` is a list. Two options level on four votes each is the moment somebody
has to talk, and a screen that picked one of them by id order would have hidden
exactly the thing worth knowing. Empty while nobody has voted.

## The two rules a client is not trusted with

Both are enforced on the way in, because a client that got either wrong would
corrupt the count *for everybody* and nothing would report an error.

**Single choice means one live vote.** Picking a second option withdraws the
first, on the server, inside the same transaction. The browser does the same
thing optimistically so the ballot moves under the finger — without that, a
single-choice vote would show two options ticked until the next pull, which
reads as a broken rule rather than as latency.

**A closed vote refuses.** A refusal rather than a correction, which is the
opposite of what the budget and KPI invariants do: silently dropping a vote
tells the person they voted. Withdrawing is refused too, and on purpose — a
result somebody can still shrink after it has been quoted is not a result.

A vote is also always filed under whoever cast it. `voter_id` never comes off
the wire, and a vote written at somebody else's derived id is refused rather
than corrected, because there is no honest way to guess what was meant.

## Where a decision lives

`project_id` scopes it the way a page is scoped: one project's own, or the
workspace's when it is null. A decision that names a task takes **that task's
project**, whatever was sent — the sync filter scopes by project alone, so a row
whose two answers disagree is a vote that reaches the people who cannot see what
it is about and not the ones who can.

Deleting the question takes its options and every vote with it. Deleting the
*task* does the opposite and leaves the decision standing, undated from the
work: the same direction a KPI target takes when its milestone goes, and for the
same reason — deleting the ticket does not unmake the choice the team took on
it.

## Through MCP

| Tool | |
|---|---|
| `list_decisions` | what is being asked, with `state` — open, closed, or expired |
| `decision_result` | one decision in full: counts, shares, who is leading |
| `create_decision` | a question with at least two options |
| `cast_vote` | vote, or withdraw by voting for what you already hold |
| `close_decision` | turn a ballot into a record, or take it up again |

`decision_result` answers `voters: null` on a secret ballot's options rather than
an empty list. "Nobody chose this" and "you may not know who" are different
facts, and an empty array says the first one.

## What it is not

- **Not ranked or weighted.** No ordering your five, no ten points to spread
  across them. Both answer a different question and need a different count, a
  different bar and a different explanation of who won. See `TODO.md`.
- **Not a quorum.** Nothing says how many people had to vote for the result to
  stand, because nothing here knows who was asked — a workspace is not an
  electorate. The turnout is reported and the reader decides.
- **Not a notification.** A deadline passing sends nothing, for the reason
  nothing runs when it passes at all.
- **Not a governance record.** Closing a vote records what people picked, not
  what was decided. Those differ often enough that conflating them would make
  the honest half untrustworthy; write the decision down on a page and link the
  ballot from it.
