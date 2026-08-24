# Task reviews

Kolibri can ask a model to read a task back to whoever wrote it, and suggest clearer wording. It is
off until two different people switch it on, it only ever runs when somebody clicks a button, and it
never writes anything by itself.

This is the one feature that sends a workspace's own words to a company. Everything below is shaped
by that.

## What it does

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

## What leaves the instance

The project name, the column, the labels, the title and the description. Long descriptions are
trimmed at 6000 characters.

Not the assignees, not the dates, not the estimate, not the comments, not the attachments. None of
them makes a task easier to understand and every one of them is somebody's information.

Nothing is stored. The review lives as long as the panel does; what survives is whatever was
applied, which is a normal edit. There is no new table and nothing new in sync.

## Switching it on

Two switches, because two different people are deciding.

**The operator** puts a key in the environment. That is what makes a model reachable at all, and it
is reported on `/api/health` as `ai` beside `mail`.

**A workspace admin** turns on *Task reviews* under Settings → Workspace. Until then the button does
not exist, on an instance with a key and everything. When no key is configured the row says so
instead of offering a switch that would do nothing.

Then: members and above, with a writing token. Guests are refused — they could not apply a word of
it, and this is the only click in the app that spends money.

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

KOLIBRI_AI_TIMEOUT_MS=20000
# Reviews one person may ask for: a burst of this many, one back every N seconds.
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

## For the person who has an assistant already

Kolibri is MCP-native, so anyone driving it from an agent can already ask their own model to read a
task, with their own key and their own data path — `docs/mcp.md`. This feature exists for everybody
else, which is most people.

## How it is built

| File | What it is |
|---|---|
| `lib/ai.ts` | What a provider is: one function, one error class that carries whether retrying could help |
| `lib/ai-anthropic.ts`, `lib/ai-gemini.ts`, `lib/ai-openrouter.ts` | One adapter each — the URL, the auth header, and where the answer sits |
| `lib/review.ts` | The prompt, and `parseReview` |
| `routes/ai.ts` | `POST /api/tasks/:id/review` and the three gates |
| `components/task-review.tsx` | The panel |

Plain `fetch`, like the Scaleway and Telegram clients, because the server has no runtime
dependencies and is not about to grow one. A provider URL comes from the environment, so it does not
go through the SSRF checks in `lib/outbound.ts` — those exist for URLs a *user* supplies, and
routing through them would break a perfectly reasonable gateway on `http://ollama:11434`.

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
