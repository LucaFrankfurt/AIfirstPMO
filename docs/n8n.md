# n8n

Both directions already work, with no n8n-specific code in this project and no community node to
install. Kolibri calls out over a webhook and reads back over the REST API or MCP — which is what
n8n's Webhook, HTTP Request and MCP nodes speak.

This page is the two recipes and one worked report. If something here does not match what your
instance does, `docs/api.md` is the reference and this is the tutorial.

## Kolibri → n8n: the trigger

Add an n8n **Webhook** node, copy its *production* URL, and make an outgoing hook with it. In the
app that is *Settings → Integrations → Add a webhook*; over the API:

```bash
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"n8n","url":"https://n8n.example.com/webhook/kolibri","format":"kolibri",
       "events":"task.moved,task.completed,time.logged"}' \
  "$URL/api/workspaces/$WS/webhooks"
```

`format` must stay `kolibri` — `slack` and `discord` send a rendered sentence, which is the wrong
thing to hand a workflow. The body is:

```json
{ "event": "task.moved", "at": 1767225600000, "instance": "https://kolibri.example.com",
  "data": { "identifier": "WEB-42", "title": "…", "from": { "name": "In progress", "group": "started" },
            "to": { "name": "In review", "group": "started" }, "…": "…" } }
```

Which events exist, and what each payload carries, is the table in
[`api.md`](api.md#integrations). Two of them are the reason this is a trigger and not a poll:
`task.moved` says which state a task *left*, which no amount of polling reconstructs, and
`task.deleted` is the only news about a row that will not be there when you go looking.

**On the same Docker network.** Kolibri refuses to post to a private address unless it is told to —
otherwise anybody who can save a webhook can make the server call whatever is listening beside it.
So a URL like `http://n8n:5678/webhook/kolibri` needs:

```bash
KOLIBRI_ALLOW_PRIVATE_WEBHOOKS=1
```

That is the one setting this integration needs, and it is off by default on purpose. See
[`deployment.md`](deployment.md#what-the-server-does-to-protect-itself).

### Checking the signature

Every call carries `x-kolibri-signature: sha256=<hex>` — an HMAC-SHA256 of the exact bytes, with the
hook's secret. Read the secret once from *Settings → Integrations* (or
`GET /api/webhooks/:id/secret`, admin only) and keep it in n8n's credentials or environment.

Turn on **Raw Body** in the Webhook node, then a Code node:

```js
const secret = $env.KOLIBRI_HOOK_SECRET;
const item = $input.first();
const raw = Buffer.from(item.binary.data.data, 'base64');            // the bytes as sent
const sent = item.json.headers['x-kolibri-signature'] ?? '';

const key = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
);
const mac = await crypto.subtle.sign('HMAC', key, raw);
const mine = 'sha256=' + Buffer.from(mac).toString('hex');

if (mine !== sent) throw new Error('Not from Kolibri');
return [{ json: JSON.parse(raw.toString('utf8')) }];
```

Without the raw body, `JSON.stringify(item.json.body)` happens to reproduce the same bytes — the
server sends compact JSON and key order survives a parse — but it is a coincidence worth not
building on if the raw body is one checkbox away.

### Retries, and not acting twice

A delivery that fails is tried five times over about half an hour: a 429 or a 5xx is a bad moment,
anything else in the 4xx range is this request and is given up on at once. So an n8n that is
restarting does not cost you the event.

Which means a workflow can see the same delivery twice — the far end timing out after having
already done the work is the ordinary case. Every attempt of one delivery carries the same
`x-kolibri-delivery` header, so the way to be safe is to key on it: a Redis/`Remove Duplicates`
node, or an "already seen" check in whatever the workflow writes to.

If it ran out of attempts anyway, the log is under the hook in *Settings → Integrations*, and
*Send again* replays the event as it was recorded.

## n8n → Kolibri: reading and writing

Create a token in *Settings → API & MCP*, pinned to a workspace, `read` if the workflow only looks.
Then either of these, in an **HTTP Request** node with a Header Auth credential of
`Authorization: Bearer kol_…`:

**The REST API**, one collection at a time:

```
GET  {{$env.KOLIBRI_URL}}/api/workspaces/{{ws}}/tasks?cycle_id={{cycle}}&limit=1000
POST {{$env.KOLIBRI_URL}}/api/workspaces/{{ws}}/tasks     { "project_id": "…", "title": "…" }
```

Every entity has the same five routes and any field is a filter — see [`api.md`](api.md#entities).

**Or MCP**, which is where the reports already live. `POST /mcp` takes plain JSON-RPC with the same
bearer token, no handshake and no AI node involved:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "cycle_review", "arguments": { "project": "WEB" } } }
```

The answer is in `result.structuredContent`. `cycle_review`, `project_status`, `workload`,
`deadlines_at_risk`, `blocked_tasks`, `stale_tasks` and `changes_since` each replace a page of
list-and-join work in a workflow. The full set is in [`mcp.md`](mcp.md).

If you *are* building an AI Agent node, point n8n's **MCP Client Tool** node at the same URL with
the same header and it gets all 50 tools at once.

## A sprint report, end to end

What most people mean by "a report in n8n": when the cycle ends, put together what happened and post
it somewhere.

1. **Trigger.** A Schedule node on the morning after, or a Webhook node subscribed to
   `cycle.updated` with an IF node on `data.changed` containing `status`.
2. **The numbers.** One HTTP Request to `/mcp` with `cycle_review` — what the cycle held, what got
   finished, what did not, and what was added after it started.
3. **The hours**, if the report needs them:
   `GET /api/workspaces/:ws/time-entries?project_id=…` and sum `minutes`. `time.logged` is also an
   event, if you would rather accumulate as you go.
4. **The names.** Payloads and API rows carry `assignee_ids`, not names: `GET
   /api/workspaces/:id/members` once, and use it as a lookup table.
5. **The write-up.** Post it back as a Kolibri page —
   `POST /api/workspaces/:ws/pages { "project_id": "…", "title": "Sprint 12", "content": "…" }` —
   or into Slack, or into a spreadsheet. A page written this way is an ordinary page: it syncs, it
   is searchable, and somebody can edit it afterwards.

For a report that is *about* dates rather than events, there is also a subscribable `.ics` feed per
person and per saved view — [`calendar.md`](calendar.md) — which n8n can read directly.

## What this is not

- **There is no `n8n-nodes-kolibri` package.** You paste a URL and a token; there is no Kolibri
  trigger node, no credential type and no resource picker.
- **No ordering guarantee.** Two events fired a millisecond apart are two HTTP requests, and the
  second can arrive first. Anything order-sensitive should read the current row rather than trust
  the sequence it heard about.
- **A hook is per workspace**, optionally narrowed to one project. There is no instance-wide firehose.
- **Retries stop after five attempts.** After that the delivery sits in the log until somebody
  replays it. Nothing is queued forever, on purpose.
