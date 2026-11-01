# Task reviews and canvas boards

Kolibri can ask a model two things: to read a task back to whoever wrote it and suggest clearer
wording, and to draw a board on a canvas or change one. Both are off until two different people
switch them on, and both only ever run when somebody clicks a button.

This is the one feature that sends a workspace's own words to a company. Everything below is shaped
by that.

## Reviewing a task

A task sheet grows a **Review** section under the description. Clicking *Ask for a review* sends the
task to whichever model is configured and shows what came back:

- a one-sentence verdict;
- **findings**, each one a problem in a sentence plus the finished replacement text — a title that
  names an outcome instead of a component, a description somebody outside the conversation could act
  on, acceptance criteria you could actually check, or "this is three tasks";
- **questions**, which are the things only a person knows.

Every finding that offers to rewrite something comes with the text already written. *Use this*
applies it as an ordinary edit: it syncs, it merges, and it shows up in the activity tab under the
name of whoever accepted it, because that is who decided. Nothing else changes.

The questions have one button, *Ask in a comment*, which posts them as a comment on the task. A
model that cannot tell which export is meant is told to ask rather than guess, and a question with
nowhere to go is a dead end — this puts it in front of the person who can settle it, through the
normal comment and notification path.

### What leaves the instance

The project name, the column, the labels, the title and the description. Long descriptions are
trimmed at 6000 characters.

Not the assignees, not the dates, not the estimate, not the comments, not the attachments. None of
them makes a task easier to understand and every one of them is somebody's information.

Nothing is stored. The review lives as long as the panel does; what survives is whatever was
applied, which is a normal edit. There is no new table and nothing new in sync.

## Boards on a canvas

A canvas's *Add board* menu grows **Describe it to Claude…**, and a board's editor grows **Ask
Claude** — each named after the model the server is configured with, so a Gemini instance says
Gemini, and one behind a gateway says "the model". The first draws a new board from a sentence; the
second changes the open board as asked. See [`canvas.md`](canvas.md#where-a-board-comes-from).

The model is told two sets of rules (`BOARD_SYSTEM` in `modules/ai-review/board.ts`). The first
decides whether the board works at all: a board is drawn in a sandbox that reaches no network, so a
page that loads Tailwind or Chart.js from a CDN — the first thing a model reaches for — would draw an
empty box. The rules forbid fetching anything and name what to use instead: system fonts, inline
SVG, CSS. The second decides whether people can keep working on it: the visual editor restyles an
element through its `style` attribute, so the look is asked for there, not in a stylesheet nobody
can recolour without writing CSS. And the board is read on phones: it is asked to reflow at about
390px — grids as `repeat(auto-fit, minmax(…))`, rows that wrap, wide tables in a scrolling box —
because what the app can do for a board that was not (`fitBoard`, in `canvas.md`) is a repair, and
a layout by absolute position it cannot repair at all. The
same rule is in the MCP tools' descriptions, which is what an assistant writing boards reads.
*Make it fit phones*, on a board page too wide for the screen, asks for exactly that of an existing
board.

An answer is read leniently and checked strictly. A document wrapped in a code fence or a sentence
is cut out of it; markup without a document around it gets one; a reply with no page in it is an
error, and nothing is put anywhere.

### What leaves the instance

- the description typed into the dialog;
- the canvas's title, which is usually what its boards are about;
- the frame's size;
- for a change, the board's current HTML, whole;
- for a new board with *Match the look* ticked (the default when there are boards already), up to
  two other boards' HTML, each cut at 6000 characters.

Not the comments, not the notes, not who is on the canvas. Untick *Match the look* and no board's
content is sent at all. The dialog says so before anybody clicks.

Nothing is stored beside the board. The answer is written by the person who asked, through the
ordinary write path — it syncs, it merges, it is in the board's history, and in the editor it is one
step of *Undo*.

**What it costs.** A board is an answer of thousands of tokens — a 20,000-character page is roughly
6,000 — where a review is under 1k, so think of one board as ten reviews or more. That is an
estimate from the size of pages, not a measurement against a bill. The ceiling is 16,000 tokens,
thinking included, at `effort: medium`: a page is design work, which is worth more thought than a
review's JSON.

**How long it takes.** A minute or two, and the dialog says so. The request waits for the whole
board, with at least five minutes before the server gives up — a longer `KOLIBRI_AI_TIMEOUT_MS`
still wins. Nothing else on the way cuts it: the server has no request timeout, and the nginx
configuration in `deployment.md` waits an hour. A proxy of your own with a shorter read timeout
would end the request before the board arrives.

## Switching it on

Two switches, because two different people are deciding.

**The operator** puts a key in the environment. That is what makes a model reachable at all, and it
is reported on `/api/health` as `ai` beside `mail`.

**A workspace admin** turns on *Task reviews and canvas boards* under Settings → Workspace. Until
then neither button exists, on an instance with a key and everything. When no key is configured the
row says so instead of offering a switch that would do nothing.

Then: members and above, with a writing token. Guests are refused — they could not apply a word of
it, and this is the only click in the app that spends money. A board is drawn only for somebody who
can see its canvas; anybody else is told there is no such page, and the model is never asked.

## Configuration

```bash
# Whose model. Leave unset and it is read off whichever vendor key is present,
# Anthropic first. Naming a provider with no key switches the feature off rather
# than quietly falling through to a different company.
KOLIBRI_AI_PROVIDER=            # anthropic | gemini | openrouter

# The key. The vendor's own variable name is read too, so a .env that already
# has ANTHROPIC_API_KEY in it needs no second copy of the same secret.
KOLIBRI_AI_API_KEY=             # or ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY

# Which model. Each provider has a default; this is the cost lever.
KOLIBRI_AI_MODEL=

# A gateway, a proxy, or a model on the same docker network. An OpenAI-shaped
# gateway works through the OpenRouter adapter.
KOLIBRI_AI_BASE_URL=

# A review's. A board waits at least five minutes, or this if it is longer.
KOLIBRI_AI_TIMEOUT_MS=20000
# Requests one person may make: a burst of this many, one back every N seconds.
# Counted separately for reviews and for boards.
KOLIBRI_AI_BURST=10
KOLIBRI_AI_EVERY_SECONDS=20
```

Defaults per provider:

| `KOLIBRI_AI_PROVIDER` | Default model | Endpoint |
|---|---|---|
| `anthropic` | `claude-opus-5` | `POST /v1/messages` |
| `gemini` | `gemini-2.5-flash` | `POST /v1beta/models/{model}:generateContent` |
| `openrouter` | `anthropic/claude-opus-4.5` | `POST /v1/chat/completions` |

**What it costs.** A review is roughly 1.5k tokens in and under 1k out — a few cents on a large
model, a fraction of a cent on a small one. `KOLIBRI_AI_MODEL` is there so that is your decision.

**Models that think.** Every current model does, and every adapter here asks it to stop: `effort:
low` on Anthropic, `thinkingLevel: LOW` on Gemini 3 and later. Reviewing a task is not what deep
reasoning is for, and it is billed by the token. A board asks Anthropic for `effort: medium`; the
other adapters have no such setting to pass.

The one that is not a preference is the budget. A model spends its output ceiling thinking first and
answering second, so a ceiling sized for the answer alone is spent before the answer starts — and
what comes back is an empty response, or half a JSON object that reads downstream as a model talking
nonsense. So the Gemini adapter adds its room to think on top of the room to answer, and all three
adapters say *ran out of tokens* when that is what happened rather than blaming the model for the
truncation. Unused room is not billed.

`thinkingLevel` is a Gemini 3 field and sending it to 2.5 is an error, so the major version is read
out of the model name. A name that is not a recognisable `gemini-N` — your own gateway, named
however you named it — is sent no thinking config at all.

## For the person who has an assistant already

Kolibri is MCP-native, so anyone driving it from an agent can already ask their own model to read a
task, with their own key and their own data path — `docs/mcp.md`. This feature exists for everybody
else, which is most people.

## How it is built

Server paths are under `packages/server/src/`, client paths under `packages/web/src/`.

| File | What it is |
|---|---|
| `modules/ai-review/model.ts` | The port: what a request is, one error class that carries whether retrying could help |
| `adapters/ai/ai.ts` | The one `fetch` every adapter goes through, and its clock |
| `adapters/ai/ai-anthropic.ts`, `ai-gemini.ts`, `ai-openrouter.ts` | One adapter each — the URL, the auth header, and where the answer sits |
| `modules/ai-review/review.ts` | A review's prompt, and `parseReview` |
| `modules/ai-review/board.ts` | A board's rules, what is sent, and `htmlFromReply` |
| `modules/ai-review/routes/ai.ts` | `POST /api/tasks/:id/review`, `POST /api/pages/:id/boards/draft`, and their gates |
| `modules/ai-review/task-review.tsx` (web) | The review panel |
| `modules/ai-review/board-ai.ts` (web) | What a canvas is handed: the model's name and a way to ask it, or nothing |
| `modules/pages/canvas-dialogs.tsx` (web) | The describe and import dialogs |

Plain `fetch`, like the Scaleway and Telegram clients, because the server has no runtime
dependencies and is not about to grow one. A provider URL comes from the environment, so it does not
go through the SSRF checks in `adapters/webhooks/outbound.ts` — those exist for URLs a *user* supplies, and
routing through them would break a perfectly reasonable gateway on `http://ollama:11434`.

The canvas does not import the model. `ai-review` already leans on pages — a review reads a task, a
board draft reads a canvas — so the page route hands the canvas a `CanvasAi` from `board-ai.ts`, and
the arrow between the two modules keeps pointing one way.

**`parseReview` is the only code in the system that trusts a model.** A model asked for JSON will
sometimes send prose, sometimes JSON wearing a code fence, and sometimes valid JSON offering to
rewrite a field this app does not let a review touch. So it strips fences, finds the object, and
argues with every field: an unknown `kind` becomes `other`, a finding naming a field that is not
`title` or `description` keeps its sentence and loses its button, a replacement identical to what is
already there is dropped, and a verdict of "clear" alongside four findings is overruled by the
findings. Anything it cannot read at all is an error, not a half-built review — a panel showing
three fields of a five-field answer is a bug that looks like a model being terse.

The prompt's most important rule is not about style: **never invent a fact the task does not
contain.** A confident rewrite naming the wrong export is worse than no review, because a click puts
it in the description under somebody else's name.
