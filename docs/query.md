# Typing instead of clicking

Two small languages, both of them surfaces over structures that already existed.

- **Quick add** turns one line into a task: `Redraw the empty state !high @ada
  #WEB *design due:friday`.
- **Filter as text** turns one line into a view's filter: `assignee = me AND
  priority in (urgent, high) AND state != Done`.

Neither adds power. What they add is that a thing which was a sequence of clicks
becomes something you can paste into a message, keep in a page, diff against
last week's, and read out loud.

---

## Quick add

Press `c`, or the **+** button. Everything except the words is optional.

| You type | It means |
|---|---|
| `!urgent` `!high` `!medium` `!low` — or `!1` … `!4` | Priority. `!1` is the urgent end, the way every tool that numbers them does it |
| `@ada` `@"Ada Lovelace"` `@me` | Assignee. Repeatable |
| `#WEB` `#"Public API"` | Project, by key or by name |
| `*design` `*"needs research"` | Label. Repeatable |
| `due:friday` `due:tomorrow` `due:2026-09-04` `due:+3d` | Due date |
| `every:weekly` `every:2w` `repeat:monthly` | Repeat |

The words in `due:` and `every:` work in English, German and French —
`due:freitag`, `every:wöchentlich`, `due:demain`.

**A weekday always means the next one.** `due:friday` typed on a Friday is next
Friday: somebody typing the name of today's day means the one coming, or they
would have typed `due:today`.

### Two decisions worth knowing about

**Dates need the `due:` prefix.** The obvious next step is to read a bare
`tomorrow` or `monday` out of the middle of a sentence, and it is what makes
this feature magical right up until *Meeting Monday* becomes a task called
"Meeting" and nobody can see where the word went. A prefix is two characters and
is never wrong. The exception is a relative offset — `+3d`, `+2w` — which is not
a word in any of the three languages this app speaks and so cannot be eaten out
of anybody's sentence.

**A token nothing answers to stays in the title.** `!important` is a word;
`!urgent` is a priority. The difference is whether the workspace has something by
that name, not whether the line starts with a sigil. Same for `@nobody`,
`#hashtag` and `*asterisk`. An ambiguous `@alex` where two people are called Alex
matches **neither** — quietly assigning work to the wrong Alex is worse than not
assigning it.

The box shows what it read as chips underneath, so nothing is applied invisibly,
and the token is still in the line to be deleted.

### Over MCP

`create_task` takes an **opt-in** `quick_add` string:

```json
{ "quick_add": "Redraw the empty state !high @ada #WEB due:friday" }
```

`title` is never parsed. A tool with a schema should mean what the schema says:
an assistant that writes *"Discuss with @ada"* as a title means those words, and
a parser that quietly removed them and assigned the task would be a surprise
nobody asked for. `quick_add` is for the other case — relaying a line a person
actually typed. With `#KEY` in it, `project` is not needed.

---

## Filter as text

The **Query** button beside the filter menu. It opens with the current filter
already written out, because a query language you have to learn before it shows
you anything is one nobody learns.

```
assignee = me AND state != Done
priority in (urgent, high) AND due = overdue
project = WEB AND label in (design, ops)
is: open AND cycle = none
```

| Field | Also spelled | Values |
|---|---|---|
| `state` | `status` | a state's name |
| `type` | `kind` | a work-item type |
| `is` | `group` | `backlog` `unstarted` `started` `completed` `cancelled`, or `done` / `open` |
| `priority` | `p` | `urgent` `high` `medium` `low` `none` |
| `assignee` | `assigned` | a name, an email address, or `me` |
| `label` | `tag` | a label's name |
| `cycle` | `sprint` | a cycle's name |
| `module` | `milestone` | a module's name |
| `project` | | a key or a name |
| `due` | | `overdue` `today` `week` `none` |
| `text` | `title`, `summary` | anything |

| Operator | Meaning |
|---|---|
| `=` `:` | is |
| `!=` | is not |
| `in (a, b)` | is one of |
| `not in (a, b)` | is none of |
| `~` | contains (text only) |

Clauses join with `AND` — writing it is optional, `state = Todo priority =
urgent` works. A **bare word** with no operator is a text search, which is what
somebody typing into a filter box means nine times in ten. `none` (or `empty`,
or `nobody`) is the empty answer: `assignee = none` is the unassigned ones.

### What it deliberately cannot do

`Filters` is a conjunction of *is one of* and *is not one of*. That is what a
saved view stores, what the board reads, what a share link resolves and what the
calendar feed queries — so the language is exactly that and no more:

- **`OR` between two different fields.** `assignee = me OR priority = urgent`
  cannot be a saved view. The error says so and suggests the form that works:
  several answers to *one* field, `priority in (urgent, high)`.
- **A date comparison.** `due < 2026-09-01` is not one of the four buckets a
  view holds. `due < today` and `due <= 7d` are accepted as ways of writing
  `overdue` and `week`, because those are what people type meaning them.
- **Sorting.** `ORDER BY` is a separate control on the view.
- **Custom fields.** They are named by an id, and `field.7f3a… = x` is text
  nobody can read or retype. A filter containing them keeps them untouched and
  the box says so rather than pretending the query is the whole picture.

### Errors are the feature

A query language whose failure mode is *returns nothing* is one people stare at
for five minutes. So an unresolvable name is an **error with the word in it** —
`No state here is called "Dnoe"` — and the clauses that did parse are still
applied. The unresolved one is kept rather than dropped, because a filter that
quietly widens is worse than one that matches nothing and says which word is
wrong.

### It prints back

Whatever the dropdowns did prints into the box, and whatever is typed comes back
out as the same dropdown state — so the two can never disagree. The printed form
is **canonical**: the same filter always prints the same text regardless of the
order it was built in, which is what makes one of these diffable against last
week's.
