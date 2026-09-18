# Products

What the organisation sells, what it costs to deliver, and whether selling it is
worth doing — prices, packages, campaigns, break-even, simulations and what a
customer is worth over their life.

Off by default. A workspace admin switches products on under **Settings →
Workspace**; until then there is no sidebar entry and MCP refuses. Turning them
off again hides the screens and keeps the rows.

**Independent of budgets, on purpose.** The two look adjacent and ask opposite
questions: a budget is money the organisation has decided to spend, a product is
money it hopes to take in, and a team modelling what it sells is not thereby
tracking what it spends. Where both are on they meet in exactly one word — the
cost category, which a product cost and a budget line share — so the two can be
read side by side without a translation table.

## The shape of it

| | |
|---|---|
| **Product** | Something that is sold. A name, a currency, an owner, what one unit *is*, how much of something it contains, and — where it is delivered — how many of it one delivery can take. **Not** how often it is charged: that is the price's. |
| **Group** | A family of products, for the reports that ask about a line of business. Flat: a product belongs to one or to none. |
| **Price** | One price it can be sold at. A product has several; which applies is worked out from the order size and the day. |
| **Cost** | What it costs to have and to deliver, and — the field a break-even is made of — what that cost varies with. |
| **Contributor** | Somebody outside the organisation who is part of it: the external speaker, the trainer, the subcontractor. A person with a fee, not a cost line named after them. |
| **Capability** | One thing a product can do, named once for the whole workspace. |
| **Part** | One product inside a package. |
| **Promotion** | A campaign: a price that is different for a while, what it applies to, what running it costs and what it is expected to sell. |
| **Scenario** | A set of assumptions kept beside the catalogue rather than instead of it. |

Everything is **workspace-wide**, with no `project_id` anywhere, and that is the
one scoping decision here worth defending. A budget, a cycle and a KPI carry the
three-state project scope because each of them is *about* some projects; a
catalogue is not. What a company sells is the same fact for everybody in it, and
scoping it would mean a price list that reads differently depending on which
projects you happen to be on — the worst possible property for the document
sales, delivery and finance are meant to be arguing from.

## Money is an integer, and so is every proportion

Amounts are whole numbers of **minor units** and proportions are **basis
points**, both borrowed from the budget rather than restated. `docs/budgets.md`
gives the reasoning; the short version is that `0.1 + 0.2` is not `0.3` and a
catalogue is a column of numbers that gets added up and compared to another
column that was added up differently.

One currency per product, and nothing anywhere converts between two. A catalogue
in two currencies is two totals.

## A package is a product

`kind: 'bundle'`, and a `product_parts` row per thing inside it. Not a table of
its own — which is the whole design. A package has an owner, a price,
capabilities, costs and a break-even exactly as a single product does, so every
screen, every total and every tool works on it without knowing which it is
holding.

The alternative was a `bundles` table with a price, a list of members and a
second set of everything. That is the shape where the catalogue total counts a
package and its parts twice, and where somebody has to remember which of the two
reports is the one that does not.

What the package adds is the comparison: **what it would cost bought part by
part**, against what it actually costs. A package priced *above* its parts is a
real thing — a managed service is worth more than its licences — and it should
be seen on purpose rather than discovered by a customer. A part with no price of
its own is counted and named rather than silently omitted, because a list value
missing a component is a discount figure that is wrong in the flattering
direction.

**A package costs what its parts cost**, and only the unit half of it. Selling one
package hands over `quantity` of each part, so `quantity ×` the part's unit cost
is exactly what it costs to deliver — at any depth, memoised, and cycle-guarded
because a client's mirror can hold a stale ring for the length of one sync.
Without this a bundle of two seminars with no cost rows of its own comes out at a
hundred per cent margin, which is the most confident wrong number the catalogue
could produce.

The fixed half deliberately does *not* roll up. A part's `period` cost is a
monthly bill the business pays once — the platform licence does not cost twice
because a package also references it — and adding it here would count it again in
every total that sums both. Whose delivery a package shares is a question only
the team can answer, so a package carries its own `delivery` rows and nothing is
invented.

A package may not contain itself at any depth. That is the one rule in the write
path here that **refuses** rather than corrects, because every correction
available is a guess at what somebody meant — and the failure mode is a walk
that never terminates, inside a write transaction, on a row a client will retry.

## The billing period belongs to the price

A product does not carry one, and the first real subscription modelled here is
why. The same product is sold **monthly, yearly and two-yearly at once** — those
are three prices, not three products — so a single field on the product was one
answer to a question with several. It shipped as `Product.billing` and it is
gone; `ProductPrice.recurrence` is where the period lives and always was.

That had a consequence worth writing down, because it is the shape of mistake
this whole file is written to avoid. `priceFor` ranked candidates by
`a.amount - b.amount`, and those numbers do not mean the same thing:

| | on the row | per month |
|---|---:|---:|
| Monthly | 4 900 | **4 900** |
| Yearly | 49 000 | **4 083** |

The raw comparison called the monthly price cheaper. Per month it is the dearer
of the two. So a recurring price now ranks by what it costs per month
(`comparableAmount`) and a one-off ranks by itself — and a product carrying both
is **named rather than averaged**: `mixedPeriods` says so and the screens print
the sentence, because a licence with a one-off setup fee has no single figure
that is not an assumption about how long somebody stays.

`priceFor` also takes a `recurrence` now. A screen quoting "per month" and a
customer who has chosen to pay yearly are asking different questions, and
neither is the other's answer.

## A price change is two rows, not an edit

There is no `product_price_versions` table and there should not be one. A page
has versions because its body is **overwritten** — the old text exists only if
something copied it first. A price is never overwritten: raising one closes a
window and opens another, so the old row, with its `valid_to` in the past,
already *is* the historical price, and `priceFor` has always read it that way. A
second table would be a copy of rows that are still there.

`raisePrice` returns the two rows so the client and MCP cannot disagree about
the boundary, and the boundary is the part worth stating: the old window closes
the **day before** the new one opens. Sharing a day would leave both live for
twenty-four hours, which is exactly the mistake the whole thing exists to
prevent — and `overlappingPrices` reports it when it happens anyway, rather than
resolving it, because which of two live prices was meant is not ours to guess.

The change has to land **inside the window the old price already has**, and
`priceChangeRefusal` says so before anything is written. Both ways out of it are
silent. A day on or before its `valid_from` closes the old window before it
opened, and an inverted window matches *no* day — the old amount does not become
history, it disappears, from the history table and from `priceFor` alike. A day
after its `valid_to` is the mirror: the close date moves *later* than the end
somebody already set, quietly reselling a price that had stopped, and the new row
inherits that same past `valid_to` and is born inverted too. Nothing in the
schema forbids `valid_to < valid_from` and nothing downstream reports it, so the
form greys the button out and names the end that is wrong, and `raisePrice`
throws for a caller that asked anyway.

What counts as "the same price over time" is a **lane**: same kind, same billing
period, same threshold, same commitment. A list price and a ten-seat volume price
are two lanes and both live at once; last year's list price and this year's are
one lane, one after the other. It is derived from those fields rather than stored,
because it is a fact about them and would go stale as one of them changed.

**The commitment joined the lane after a real catalogue did not fit.** The first
one modelled here sells a module at three terms at once — 64 € a month with no
commitment, 59 € on a year, 54 € on two — all billed monthly, all list prices,
all for one seat. Those three differ in nothing the lane knew about, so they
landed in one: `overlappingPrices` reported three collisions and `priceHistory`
read 64 → 59 → 54 as a price cut twice. They are three offers standing side by
side.

So `ProductPrice.term_months` sits beside `recurrence`, and for the same reason
the billing period moved off the product before it: the product holds one number
and the catalogue has several. Null means "whatever the product says" and is what
nearly every price means — a price that defers and a price stating the same
figure share a lane, because they are the same offer written two ways. `0` is an
explicit *no commitment* and is not the same as null: one says it, the other
defers. `retentionOf` takes the price's term when there is one, so a cheaper
two-year price is valued over the two years the customer actually signed for.

## Which price applies

Three filters and one preference, in this order:

1. **Kind.** `internal` is never picked unless it is asked for. A transfer price
   is not a discount and must not land in a revenue figure.
2. **Validity.** A window that has closed is not a price. Neither is one that has
   not opened — which is the case somebody enters in October for January and
   would otherwise see applied in October.
3. **Quantity.** Only prices whose `min_quantity` the order reaches.

Of what is left, the **highest `min_quantity`** wins: the most specific volume
tier the order qualifies for. The lowest amount settles a tie, because two tiers
at one threshold is somebody mid-edit and the customer should not pay for that;
the id settles the last one, so two devices holding the rows in different orders
reach the same price rather than a mergeable-looking pair of different ones.

**No applicable price is `null`, never zero.** Everything derived from it is null
as well, and every screen says "not priced". A product nobody has priced and one
priced at nothing look identical as a number and are not the same claim.

## What a cost varies with

`CostCategory` says what a cost *is* — the budget's vocabulary, shared. `basis`
says what it **varies with**, which is the only property that changes the
arithmetic:

| `basis` | Incurred | Examples |
|---|---|---|
| `period` | Every month the product exists | A platform licence, the tooling, a retainer |
| `delivery` | Each time it is delivered, whoever attends | The room, the catering, a speaker's day fee |
| `unit` | Per unit sold | The printed handbook, the payment fee, a licence passed through |

`period` and `delivery` are both fixed. They are separated because a seminar run
four times a year and one run monthly have the same room hire per run and very
different room hire per year, and one number cannot say both.

An external contributor's fee is folded in as a cost of exactly its own basis.
That is the point of them sharing the enum: a speaker on a day fee is a delivery
cost and has to be one *everywhere*, or the margin and the break-even disagree
about the same product. That they are also people — with an organisation, an
address, and a calendar somebody has to check before moving a date — is why they
are a table of their own rather than a cost line named after them.

## Break-even

Contribution per unit is the price less the **unit** costs. Fixed cost over the
horizon is the period costs by month plus the delivery costs by run. Units needed
is the second over the first, rounded up, because half a seat does not cover half
a room.

The horizon is always explicit. A fixed cost only means something against a
length of time — €400 a month is one break-even over a quarter and another over a
year — and a function that quietly picked twelve months would be picking the
answer.

Three ways there is **no** answer, and each is a different sentence on the screen:

- **No price.** Nothing to solve.
- **Contribution at or below zero.** Every unit loses money; no volume fixes it.
  Reported as such rather than as a very large number, which reads as merely
  ambitious.
- **Above capacity.** The arithmetic has an answer and the business cannot
  deliver it: nineteen seats in a room that holds twelve. This is the one a
  spreadsheet never catches, because a spreadsheet does not know about rooms.

## Campaigns

A promotion is not a fourth price with dates. It applies to **sets** — a group,
several products, the whole catalogue — and it carries two figures a price does
not: what running it costs, and what it is expected to do to volume. Without
those a campaign cannot be judged, only announced.

Empty `products` **and** empty `groups` means the whole catalogue, the same rule
an empty `projects` list follows: writing every product into a campaign that
means "everything" would mean keeping that list correct as products are created,
forever, for no gain.

Three kinds, because people mean three different things and converting between
them at entry loses the intent: "20% off" stays 20% when the list price changes,
"€200 off" does not, and "€990 for the summer" is neither — it is a price, and it
is the one a campaign is actually written around. A price never goes below zero:
120% off is somebody mistyping basis points, and a negative price would flow into
a revenue projection as income the business pays out.

Whether a campaign is running today is **derived from the dates**, never stored.
A stored phase is wrong by the next morning and right again by accident, and both
bugs it produces — a campaign that keeps discounting after it ended, and one that
never starts because nobody ran the job — are silent. What cannot be derived is
whether anybody agreed to run it, and that is what `status` says.

Campaigns stack, deepest first: applying them in the order the rows happen to
arrive would give two devices two prices.

## Simulation

`simulate` projects one product forward month by month under one set of
assumptions. Nothing it reads is edited and nothing is written, so it is safe to
put in front of a steering committee and running it twice gives the same answer.

Three things it does that a spreadsheet of the same shape usually does not, each
of them the reason for a wrong number somewhere:

- **Capacity is a ceiling, not a suggestion** — and a ceiling **per delivery**,
  so for a product that is not delivered it is no ceiling at all. `capacity ×
  deliveries` with no deliveries is zero and turned every unit away, silently,
  for exactly the products that have none: a licence, a subscription, anything
  sold rather than run. The form now asks for a capacity only where deliveries
  exist, because a field nobody should fill in is better not shown than shown
  with a warning under it.
- **Acquisition is charged in the month the customer arrives**, not spread. That
  is what makes the cumulative line dip before it climbs, and the dip is the
  entire question somebody is asking.
- **A subscription keeps paying and keeps churning.** One function rather than
  two, because two would drift: a monthly product's revenue compounds and a
  one-off sale's does not, and the difference is `billing`, not a code path.

A campaign's spend lands in the month it starts, or in the first month of the
projection when it started before it. Spreading it would invent a schedule nobody
entered; dropping it would make every campaign free.

## Retention

Three fields and no customer table: `term_months`, `renewal` and `churn_bps`,
plus `acquisition_cost` on the other side of the payback question.

Everything derived from them is an assumption and the screens say so. Nothing in
Kolibri counts customers — the churn is a number somebody types in from the system
that does — and a survival curve would need a customer register this deliberately
does not keep. See [`TODO.md`](../TODO.md).

- **A minimum term is a floor.** Inside it a customer cannot leave, so a churn
  that would have them gone sooner does not get to say so. This was wrong on the
  first subscription modelled here: twelve months' minimum term against 10%
  monthly churn read *"stays 10 months"* — a customer leaving two months before
  a contract they signed. The two disagreeing is still worth seeing, so
  `Retention.cappedByTerm` says which of them is doing the work.
- **Expected months** is `1 / churn` above that floor. Zero churn is
  *unmeasured*, not an immortal customer: it reads as null, and every screen says
  "no churn recorded" rather than rendering an infinity into a lifetime value.
- **A product that does not renew lives exactly as long as its term**, whatever
  its churn says. Churn measures people leaving something they could have stayed
  in; a fixed term that ends is not churn, and running the geometric model over
  it would quietly carry every non-renewing product past its own contract.
- **Lifetime value is net.** The acquisition cost comes off it. "LTV" as a gross
  figure is a number that makes every product look good, and leaving it out here
  would make the payback figure beside it contradict it.
- **The retention curve is geometric decay**, stated rather than implied and
  honest about what it is not: real churn is front-loaded, so this understates
  the early drop and overstates the tail.

## Over MCP

Eleven tools. Every read answers with the *derived* figures rather than the rows,
because an assistant handed four price rows and eleven cost rows will do the
arithmetic itself and get a different answer from the screen. The arithmetic
lives in `@kolibri/shared` and both sides call it.

| Tool | |
|---|---|
| `list_products` | The catalogue with price, unit cost, margin, break-even and standing |
| `product_status` | One product in full, packages and campaigns included |
| `create_product` | With its list price in the same call |
| `set_product_price` | A list, volume, partner or internal price |
| `add_product_cost` | With the basis that decides where it lands |
| `add_product_contributor` | An external speaker or subcontractor, with their fee |
| `change_product_price` | Raise or cut a price from a day, keeping the old one as history |
| `add_product_part` | Put a product in a package |
| `list_promotions` | With the phase worked out from today |
| `create_promotion` | Refuses a product or group it cannot resolve |
| `simulate_product` | A saved scenario, arguments over it, or both |
| `retention_outlook` | Lifetime value and payback, with what is missing named |

Every percentage crossing that boundary is a percentage and every one stored is
basis points, converted in one place — the alternative is a tool that takes `5`
and a tool that takes `500` for the same 5% and no way to tell from the schema.

## Where the code is

| | |
|---|---|
| `shared/src/modules/products/product.ts` | Every figure. Pure functions over plain objects, so the server and the browser cannot disagree |
| `server/src/modules/products/rules/products.ts` | Defaults, invariants, the cycle refusal, the two cascades |
| `server/src/adapters/mcp/tools/products.ts` | The ten tools |
| `web/src/modules/products/` | The screens, which compute from the local mirror and therefore work offline |
| `server/test/product.test.ts` | The arithmetic, including every case where a plausible answer is the wrong one |
| `server/test/product-api.test.ts` | The switch, the invariants, the cascades and the cycle |
