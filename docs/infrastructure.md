# The infrastructure register

Vendors, what runs where, and the documented steps from one shape of the estate
to the next.

Off by default. A workspace admin switches it on under **Settings → Workspace**.
Independent of budgets on purpose — an estate is worth writing down whether or
not anybody is costing it — and the two meet only when both are on.

## A landscape is a date, not a document

This is the decision the whole feature rests on, and the one worth reading
before anything else.

The obvious model is a *current* set of components and a *target* set beside it.
It is wrong in a way that shows up about a month in:

- the two sets have to be kept in step by hand;
- the target goes stale the moment somebody decommissions something for real;
- there is nowhere to put "and in June we will have both".

So there is no landscape table. Every component says when it joined the estate
and when it leaves, and the landscape on any day falls out of that. **Current
versus future is the same function called twice.** Nobody has to remember to
move a component from one list to the other; the day arrives and it is in.

| | |
|---|---|
| `live_from` | the day it joins |
| `live_until` | the day it leaves. Empty means no plan to retire it |

`status` — planned, live, retiring, retired — is a *label*. The dates decide.
Status answers only where a date is missing: a row marked `retired` with no end
date is gone, and one marked `live` with no start has always been here, which is
what somebody who typed neither meant.

### The gap that gets reported instead of hidden

A component marked **planned with no start date is in no landscape at all** —
not today's, not any future one. There is nowhere honest to put it.

It is not silently dropped. `livenessOn` returns `undated` for it, the landscape
screen names it in a strip above the diff, `landscape` over MCP returns it in
its own list, and the form says so while somebody is filling it in. A register
that quietly left it out of both answers would stop describing the plan, which
is the one thing it exists to do.

## Servers, and the instances on them

A component nests through `parent_id`: a machine holds its instances, a cluster
holds its nodes, an account holds its seats. The same shape a project or a page
already uses, and the server refuses a loop rather than trusting the interface.

A component whose parent is filtered out of a view comes back at the top level
rather than disappearing with it. A register that hides a running instance
because somebody filtered its host is a register that is wrong about what is
running.

Deleting works the same way: **nothing cascades a deletion.** Deleting a vendor
does not switch off its servers, and deleting a machine does not delete the
instances on it — both detach, so no row is left pointing at something that is
not there.

## What it costs

Amounts are integer minor units and one currency per component, on the same
terms as [budgets](budgets.md). Two figures come out:

**The annual run rate** is the primitive, and that is arithmetic rather than
taste. €8,900 a year divided into twelve is €741.67 a month, and twelve of those
is €8,900.04 — four cents that turn up in the total of any estate with a yearly
contract in it, every time. Multiplying up is exact; dividing down is not, so
the division happens once, at the edge, for display.

**One-off purchases are not a run rate.** A rack somebody bought returns `null`
from `annualCost` and is totalled separately. Folding it in would make the year
somebody bought hardware look like the year the estate got permanently more
expensive.

A component with no price is **unpriced**: counted, reported, never costed at
zero. The same decision `unallocated` makes in budgets and `unrated` makes for
time.

## The link to a budget

A component names the plan line it is charged to. The budget's **Plan** tab then
grows a column: what the register says, against what was planned, with the
difference where they disagree.

Neither figure is authoritative. One is a plan and the other is an inventory,
and the useful thing is being told they have drifted apart — "we budgeted €4,500
a month for hosting and the register says the machines charged to it cost
€5,200" is a sentence somebody acts on.

The component's cost fields deliberately speak the budget line's vocabulary — an
amount per occurrence plus a recurrence plus a window — so the comparison needs
no conversion in between. A conversion is where two figures start quietly
meaning different things.

## Moves: the way from one landscape to the next

A move names what it **retires** and what it **brings in**, as two lists of
components rather than as prose.

That is not a formatting choice. The same two lists that make it readable make
it checkable: a move is finished when everything it retires is gone from the
register and everything it brings in is live. So progress is read from the
register rather than from the move's own status — and where the two disagree,
the screen says so.

> A move marked done with a server still running is the discrepancy this exists
> to find. A plan nobody executed reads exactly like one that was executed,
> right up until somebody checks the estate against it.

A component deleted from the register is taken out of the moves that named it.
Otherwise the move would sit short of complete forever with nothing on the
screen able to explain the missing part.

## Vendors and the date people actually miss

A vendor carries a contract window and a **notice period in days**. Its own
field rather than a line in a note, because it is the one thing about a contract
with a deadline attached: the day you stop being able to leave is `contract_end`
minus the notice, and nothing can compute that from prose.

The vendors screen leads with the contracts whose notice date falls in the next
ninety days.

## Through MCP

| Tool | |
|---|---|
| `list_components` | the estate, optionally as of a day |
| `landscape` | one day against another: what goes, what arrives, what the difference costs |
| `record_component` | add a server, an instance, a subscription |
| `plan_move` | document a step |
| `list_moves` | every step, with how far the register says each really got |
| `list_vendors` | suppliers, their spend, and their notice dates |

A vendor named on `record_component` that does not exist yet is **created**
rather than refused. An assistant writing down an estate should not have to
create eleven suppliers before it can record a server, and a register with the
name spelled once beats one where every component is filed under nothing.

## What it is not

- **Not discovery.** Nothing scans a network or reads a cloud account. Every row
  is one somebody wrote down, which is a real limitation and the reason the
  register can be wrong.
- **Not monitoring.** No health, no uptime, no alerts. A component being in the
  landscape means somebody said it is, not that anything checked.
- **Not a CMDB.** No configuration items, no relationship types beyond "runs
  on", no change-management workflow.
- **Not restricted.** Vendors and components reach every member: their cost is a
  supplier's price rather than somebody's pay, so they follow the budget rule
  rather than the [rate](time.md) one. A move tied to a private project follows
  that project.
