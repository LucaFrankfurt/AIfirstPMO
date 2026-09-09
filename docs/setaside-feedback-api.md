# Kolibri als Feedback-Ziel für SetAside

Recherche-Bericht, gegen den Quelltext geführt und an einer laufenden Instanz nachgemessen.
Jede Aussage trägt entweder eine `datei.ts:zeile`-Fundstelle oder das Wort **nicht belegt**.

Zwei Kennzeichnungen laufen durch das Dokument:

- **gelesen** — aus dem Quelltext belegt, Fundstelle daneben.
- **gemessen** — an einer geseedeten Instanz (`KOLIBRI_DATA_DIR=… npm run seed`, Port 4477,
  `disk`-Storage) tatsächlich ausgeführt; das Ergebnis steht dabei.

Wo `docs/openapi.json` und der Handler auseinandergehen, gilt der Handler; die Stelle ist jeweils
benannt. `openapi.json` beschreibt die generierten CRUD-Routen vollständig, sagt bei den
handgeschriebenen aber ausdrücklich „read the handler" — für `POST /api/workspaces/{ws}/files`
und `GET /files/{hash}/*` steht dort nichts als der Satz selbst.

---

## Kurzfassung für die Implementierung

| Frage | Antwort |
|---|---|
| Calls von Bytes bis Screenshot am Task | **zwei** — Task anlegen, dann Upload mit `?task_id=` |
| Pflichtfeld beim Task-Create | nur `project_id`, und zwar als **UUID** |
| `{ws}` | nur die Workspace-**UUID**, kein Slug |
| Beschreibungsformat | Markdown, Roh-HTML wird escaped — **kein** eigenes Escaping nötig |
| Tabellen | ja, GitHub-Syntax |
| `image/webp` | erlaubt, wird inline ausgeliefert, Maße werden gelesen |
| Idempotenz Task | ja, über selbstgewähltes `id`-Feld (Upsert) |
| Idempotenz Upload | **nein** — ein Retry erzeugt eine zweite `attachments`-Zeile |
| Datei-Zugriffsschutz | authentifiziert, aber nur auf **Workspace**-Ebene — siehe C16/H27 |
| Rate-Limiting auf diesem Pfad | keins |

Die drei Punkte, die die Architektur auf SetAside-Seite beeinflussen, stehen in
[C16](#c16-zugriffsschutz-auf-get-fileshashpath), [D19](#d19-lässt-sich-ein-token-einschränken)
und [E23](#e23-ist-die-fehlerantwort-immer-error-message).

---

## A. Task anlegen

### A1. Minimaler Request — was ist wirklich Pflicht?

**Pflicht ist genau ein Feld: `project_id`.** Und es muss die Projekt-UUID sein.

Der Handler ist generisch (`entities.ts:641`) und validiert selbst nichts; er reicht den Body an
`writeEntity` weiter (`entities.ts:667-673`). Die Task-Regeln liegen in
`packages/server/src/modules/work/rules/work.ts:177-196`:

```ts
// work.ts:179-181
const project = get<Row>(`SELECT * FROM projects WHERE id = ?`, values.project_id);
if (!project) throw badRequest('task.project_id must reference an existing project');
if (project.workspace_id !== opts.workspaceId) throw badRequest('project belongs to another workspace');
```

**Create ohne `state_id`: geht.** `work.ts:188-192` setzt `projects.default_state_id`, ersatzweise
den ersten State nach `sort_order`:

```ts
// work.ts:188-192
if (!values.state_id) {
  const fallback = project.default_state_id
    ?? get<Row>(`SELECT id FROM states WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order LIMIT 1`, project.id)?.id;
  if (fallback) setForced('state_id', fallback);
}
```

**Create ohne `project_id`: geht nicht** — `400 bad_request`.

**`title` ist nicht Pflicht.** Die Spalte ist `TEXT NOT NULL DEFAULT ''` (`schema.sql:699`), und
keine Regel prüft sie. Ein Task ohne Titel wird angelegt und trägt `""`.

Was der Server beim Create sonst noch selbst setzt (`work.ts:182-195`):

| Feld | Quelle | Fundstelle |
|---|---|---|
| `number`, `identifier` | `projects.next_number`, hochgezählt in derselben Transaktion | `work.ts:182-187` |
| `state_id` | Default-State des Projekts | `work.ts:188-192` |
| `created_by` | Token-Eigentümer, **nur wenn leer** | `work.ts:193` |
| `sort_order` | `'V'` | `work.ts:194` |
| `subscribers` | `[actorId]`, **nur wenn leer** | `work.ts:195` |
| `priority` | `'none'` (Spalten-Default) | `schema.sql:707` |

**gemessen** — `POST` mit ausschließlich `project_id` und `title`:

```json
{"id":"b661a95e-…","identifier":"WEB-10","number":10,"title":"minimal create",
 "state_id":"f4d13e86-…","created_by":"21abbfaf-…","priority":"none","sort_order":"V",
 "subscribers":["21abbfaf-…"],"description":null}
```

**gemessen** — die drei Fehlerfälle:

```
POST {"project_id":"<uuid>"}                → 200, title ""
POST {"title":"no project"}                 → 400 {"error":"bad_request","message":"task.project_id must reference an existing project"}
POST {"project_id":"WEB","title":"by key"}  → 400 (dieselbe Meldung)
```

> **Divergenz zu `openapi.json`:** dort hat `Task` kein `required`-Array, weil das Schema aus der
> Registry generiert wird (`entities.ts:181-191` in `packages/shared`) und die Registry keine
> Pflichtfelder kennt. Der Handler kennt genau eins. Der Handler gilt.

### A2. Was akzeptiert `{ws}`?

**Nur die Workspace-UUID.** `requireWorkspace` schlägt in einer Map nach, die auf
`workspace_members.workspace_id` — also der ID — aufgebaut ist:

```ts
// auth.ts:186-192
export function requireWorkspace(ctx: Ctx, workspaceId: string, minRole: WorkspaceRole = 'guest'): WorkspaceRole {
  const auth = requireAuth(ctx);
  const role = auth.memberships.get(workspaceId);
  if (!role) throw forbidden('You are not a member of this workspace');
```

`loadMemberships` (`auth.ts:86-92`) liest `SELECT workspace_id, role FROM workspace_members`. Der
Slug wird nirgends aufgelöst — in `packages/server/src/kernel/identity/routes/workspaces.ts` kommt
`slug` nur beim Anlegen vor (`workspaces.ts:29-31`).

**gemessen** — `GET /api/workspaces/kolibri/projects` mit gültigem Token:

```
403 {"error":"forbidden","message":"You are not a member of this workspace"}
```

Der Status ist bemerkenswert: ein unbekannter Workspace ist **403, nicht 404** — siehe [E21](#e21-statuscodes).

Die UUID steht in `GET /api/session` (`routes/auth.ts:355`) unter `workspaces[].id`; der Slug steht
daneben und ist für die API wertlos.

### A3. Was akzeptiert `project_id`?

**Über REST: ausschließlich die UUID.** Der Lookup ist `WHERE id = ?` (`work.ts:179`), ohne
Fallback auf Key oder Name. **gemessen:** `{"project_id":"WEB"}` → `400 bad_request`.

Das MCP-Tool `create_task` ist der Sonderfall, den die Frage vermutet — dessen Beschreibung
„Project id, key or name" (`packages/server/src/adapters/mcp/tools/tasks.ts:169`) ist korrekt, weil
MCP vorher durch `findProject` geht:

```ts
// packages/server/src/adapters/mcp/kit.ts:91-95
const row = get<Row>(
  `SELECT * FROM projects WHERE workspace_id = ? AND (id = ? OR key = ? OR lower(name) = lower(?)) AND deleted_at IS NULL`,
  workspaceId, ref, ref.toUpperCase(), ref,
);
```

Diese Auflösung liegt **im MCP-Adapter, nicht im Write-Path** — REST sieht sie nicht. Für SetAside
heißt das: die Projekt-UUID einmal konfigurieren, nicht den Key.

### A4. Response-Shape des Create

**`id` und `identifier` kommen beide zurück**, zusammen mit der vollständigen serialisierten Zeile.
`serialize` (`repo.ts:42-66`) gibt jedes Feld der Registry aus, plus `serverOnly`-Felder — und
`number`/`identifier` sind genau die (`packages/shared/src/kernel/registry/entities.ts:189`).

Vollständige Antwort, **gemessen**:

```json
{"id":"f7b35a96-…","workspace_id":"d71146ab-…","project_id":"56c4633e-…","title":"",
 "description":null,"state_id":"f4d13e86-…","priority":"none","assignees":[],"labels":[],
 "parent_id":null,"cycle_id":null,"module_id":null,"estimate":null,"start_date":null,
 "due_date":null,"sort_order":"V","completed_at":null,"archived":0,"created_by":"21abbfaf-…",
 "subscribers":["21abbfaf-…"],"recurrence":null,"recurred_from":null,
 "number":11,"identifier":"WEB-11","created_at":1788954613971,"updated_at":1788954613971,
 "deleted_at":null,"seq":149}
```

`identifier` ist `${project.key}-${number}` (`work.ts:186`), also `FB-12` bei Projekt-Key `FB`. Ein
Unique-Index sichert die Eindeutigkeit pro Workspace (`schema.sql:732`).

### A5. Welche Identität bekommt `created_by`?

Bei Token-Auth: **die Identität des Menschen, dem das Token gehört.** `authenticate` liest
`api_tokens.user_id` und baut daraus dieselbe `Auth` wie für eine Session
(`auth.ts:140-146`, `auth.ts:166-179`). Ein Token ist kein eigenes Subjekt.

**Maschinen-/Bot-User gibt es nicht.** In `users` (`schema.sql:11-40`) existiert kein `is_bot` oder
Vergleichbares; ein `grep -rni "is_bot\|bot_user\|service account"` über `packages/server/src` und
`packages/shared/src` liefert nichts. Was es gibt, ist ein gewöhnliches Benutzerkonto, das man
„SetAside" nennt und dem das Token gehört — das ist die einzige Form von Maschinenidentität hier.

**Und es gibt etwas Besseres als Prosa für den Melder:** `created_by` steht in `fields`
(`entities.ts:186` in `packages/shared`), ist also vom Client schreibbar, und `work.ts:193` setzt es
nur, *wenn es leer ist* (`if (!values.created_by)`). Dasselbe gilt für `assignees` und `subscribers`
(`work.ts:195`).

**gemessen** — Token gehört Ada, Body nennt Alan:

```
POST {"project_id":"…","title":"im Namen von Alan","created_by":"<alan-uuid>",
      "assignees":["<alan-uuid>"],"subscribers":["<alan-uuid>"]}

→ created_by: e0a7e9c7-… (Alan)     assignees: ["e0a7e9c7-…"]     subscribers: ["e0a7e9c7-…"]
```

Wenn der Melder ein Kolibri-Konto hat, kann SetAside den Task also **auf ihn ausstellen** statt ihn
im Text zu nennen — und ihn über `subscribers` automatisch benachrichtigen lassen.

Eine Einschränkung, die man kennen muss: **`created_by` wird nicht validiert.** `SCOPED_REFERENCES`
(`repo.ts:187-214`) listet die Fremdschlüssel, die geprüft werden, und `created_by` ist bewusst
nicht dabei — der Kommentar bei `repo.ts:185-186` sagt, die Liste sei „deliberately only the columns
a *client* may write", was für `created_by` seit dem Registry-Eintrag nicht mehr stimmt.
**gemessen:** `{"created_by":"nicht-existent"}` wird mit `200` angenommen und so gespeichert.
Für SetAside ist das kein Risiko, aber der Wert muss vorher aufgelöst sein — eine E-Mail-Adresse
reicht nicht, es muss die User-UUID sein.

---

## B. Beschreibungsformat

### B6. In welchem Format wird `Task.description` gespeichert und gerendert?

**Gespeichert wird der Rohtext, gerendert wird als Markdown.** Es gibt keine Formatspalte und keine
Umwandlung beim Schreiben: `writeEntity` normalisiert nur Typen (`repo.ts:246-251`) und legt den
String ab (`schema.sql:700`, `description TEXT`).

Der Renderer ist genau einer:

```
packages/web/src/modules/work/TaskDetail.tsx:229-232
  <Markdown source={task.description} … />

packages/web/src/modules/pages/Markdown.tsx:110
  const html = useMemo(() => renderMarkdown(source ?? '', options), [source, options]);

packages/web/src/modules/pages/Markdown.tsx:163
  <div … dangerouslySetInnerHTML={inner} />

packages/shared/src/modules/pages/markdown.ts:392
  export function renderMarkdown(source: string, refs?: MarkdownOptions): string
```

Ein zweiter Pfad existiert nicht. `sanitizeHtml` — der HTML-Allowlist-Weg — wird an vier Stellen
aufgerufen, und alle vier betreffen **Pages**, nie einen Task:
`share/routes/share.ts:200`, `pages/page-parts.tsx:479`, `pages/Html.tsx:62,148,168,344`,
`markdown.ts:433` (eingebettete HTML-Page). Die Share-Route rendert überhaupt keine
Task-`description` — `grep -n description` in `share/routes/share.ts` liefert nichts.

### B7. Sind Task-Descriptions immer Markdown?

**Ja.** `Page` hat die Spalte, `Task` nicht:

```sql
-- schema.sql:761-764 (pages)
-- Which of the two languages `content` is in: 'markdown' or 'html'. Stored
-- rather than sniffed, so a page cannot render one way here and the other way
-- in the editor.
format       TEXT NOT NULL DEFAULT 'markdown',
```

In `tasks` (`schema.sql:693-726`) gibt es kein Gegenstück, und im Registry-Eintrag
(`packages/shared/src/kernel/registry/entities.ts:181-191`) auch nicht. Belegt am Renderer:
`TaskDetail.tsx:229` ruft `<Markdown>` unbedingt auf — es gibt keine Verzweigung auf ein Format,
weil es keins zu lesen gibt.

`looksLikeHtml` (`packages/shared/src/modules/pages/html.ts:603`) könnte danach aussehen, ist aber
nur im Paste-Handler des Editors im Einsatz (`Markdown.tsx:839`) — beim Einfügen von HTML aus der
Zwischenablage, nicht beim Rendern.

### B8. Der Sicherheitstest

**Roh-HTML wird escaped. SetAside muss nicht selbst escapen.**

Das ist die erste Zeile des Renderer-Docblocks, und es ist kein Nebeneffekt, sondern das Entwurfsprinzip:

```
packages/shared/src/modules/pages/markdown.ts:1-10
 * A small, safe markdown renderer.
 *
 * Everything is HTML-escaped before any markup is generated, and only a fixed
 * set of tags is ever produced — so user content cannot inject scripts, and we
 * avoid shipping a parser plus a sanitiser for what pages and comments need.
 * […] Raw HTML never survives, which is the whole point of escaping first.
```

Mechanisch: `inline()` escaped als allererstes (`markdown.ts:186-187`), und `escapeHtml`
(`packages/shared/src/modules/pages/escape.ts:13-14`) ersetzt alle fünf Zeichen `& < > " '`.

**gemessen** — `renderMarkdown` direkt gegen die Angriffsstrings gefahren:

| Eingabe | Ausgabe |
|---|---|
| `<script>alert(document.cookie)</script>` | `<p>&lt;script&gt;alert(document.cookie)&lt;/script&gt;</p>` |
| `<img src=x onerror=alert(document.cookie)>` | `<p>&lt;img src=x onerror=alert(document.cookie)&gt;</p>` |
| `<table><tr><td>a</td></tr></table>` | `<p>&lt;table&gt;&lt;tr&gt;&lt;td&gt;a&lt;/td&gt;…</p>` |
| `<details><summary>x</summary>y</details>` | `<p>&lt;details&gt;&lt;summary&gt;x…</p>` |
| `[click](javascript:alert(1))` | `<p>[click](javascript:alert(1))</p>` (bleibt Text) |

Also: **escaped**, nicht Allowlist-gefiltert und nicht ausgeführt. Die dritte Zeile ist der Punkt,
der die Vikunja-Begründung umdreht — die heutigen HTML-Tabellen von SetAside würden als sichtbarer
Tag-Salat im Task stehen.

`javascript:`-Links fallen zusätzlich durch `safeUrl` (`escape.ts:44-54`), eine Allowlist auf
`https?:`, `mailto:`, `#` und same-origin-Pfade; der Docblock dort erklärt auch, warum `data:`
mitverboten ist.

**Konsequenz für SetAside:** das Escaping des Melder-Freitexts entfällt als Security-Control. Der
Freitext sollte trotzdem eine Behandlung bekommen, aber aus einem anderen Grund — als *Markdown*.
Ein Melder, der `**wichtig**` oder `# Überschrift` oder eine Zeile mit `|` tippt, verändert sonst
das Layout des Reports. Der saubere Weg ist ein Code-Fence:

````
```text
<hier der unveränderte Freitext>
```
````

Der Fence-Inhalt wird ebenfalls escaped und ohne jede Interpretation ausgegeben
(`markdown.ts:387-389`). **gemessen:** `{"a": "<b>"}` in einem `json`-Fence wird zu
`<pre><code class="language-json">{&quot;a&quot;: &quot;&lt;b&gt;&quot;}</code></pre>`.
Zu prüfen bleibt nur, dass der Freitext selbst keine Zeile mit drei Backticks enthält — sonst
bricht der Fence auf.

### B9. Welche Markdown-Features? Tabellen?

**Tabellen: ja**, in GitHub-Syntax. `packages/shared/src/modules/pages/markdown.ts:259-333`, erkannt
an der Delimiter-Zeile unter dem Header (`markdown.ts:511`, `alignments()` bei `markdown.ts:303-312`).
Ausrichtung über `:---`, `:---:`, `---:` wird als `style="text-align:…"` ausgegeben
(`markdown.ts:321-323`), was der Kommentar dort begründet: zwei Stylesheets lesen dieses Markup.

**gemessen:**

```
| Feld | Wert |          →  <table>
| --- | ---: |              <thead><tr><th>Feld</th><th style="text-align:right">Wert</th></tr></thead>
| Browser | Chrome 141 |    <tbody><tr><td>Browser</td><td style="text-align:right">Chrome 141</td></tr>
| URL | /leads/42 |         <tr><td>URL</td><td style="text-align:right">/leads/42</td></tr></tbody></table>
```

Escaping von Pipes funktioniert (`\|`, `markdown.ts:280-283`), und ein Pipe in einem Code-Span
trennt trotzdem die Zellen — bewusst so, weil GitHub es so macht (`markdown.ts:266-270`).

Der Rest der Features, **gemessen** bzw. am Renderer belegt:

| Feature | Status | Fundstelle |
|---|---|---|
| Tabellen | ja | `markdown.ts:259-333` |
| Überschriften `#`–`######` | ja | `markdown.ts:550` |
| Listen, verschachtelt | ja | `markdown.ts:606,627`, Zustand ab `markdown.ts:337` |
| Checklisten `- [ ]` / `- [x]` | ja, `<input type=checkbox>` | `markdown.ts:625`, gemessen |
| Fenced Code ` ``` ` inkl. Sprache | ja | `markdown.ts:380-390` |
| Eingerückter Code (4 Spaces) | **nein, bewusst** | `markdown.ts:11-13` |
| Bilder `![alt](/files/…)` | ja, mit `loading="lazy"` | gemessen |
| Autolinks | ja, `target="_blank" rel="noopener noreferrer"` | gemessen |
| Blockquotes, verschachtelt | ja | `markdown.ts:447-459` |
| Mermaid-Fences | ja, `class="md-mermaid"` | `markdown.ts:387-389` |
| `WEB-42`-Referenzen | nur wenn der Client die Projekt-Keys übergibt | `markdown.ts:30-32` |
| `[[Page]]`-Wikilinks | nur mit `pageHref` | `markdown.ts:46-59` |
| Roh-HTML | nein, escaped | B8 |
| CommonMark-Konformität | nein, ausdrücklich nicht | `markdown.ts:8` |

Für die beiden Kontextblöcke von SetAside (server-ermittelt vs. client-gemeldet) sind also zwei
Markdown-Tabellen die direkte Übersetzung der heutigen HTML-Tabellen. Ein Nebeneffekt, der
angenehmer ist als bei Vikunja: die Beschreibung bleibt im Rohzustand lesbar — in der
API-Antwort, im Export, in der Suche.

### B10. Längenlimit für `description`?

**Kein Feldlimit, keine stille Kürzung.** Die Spalte ist `TEXT` ohne Begrenzung
(`schema.sql:700`); im gesamten Write-Path und in den Work-Regeln gibt es kein `slice`/`length`
gegen `description` (`grep -i "slice\|length\|limit\|max"` über
`packages/server/src/kernel/write-path/` und `packages/server/src/modules/work/` liefert nichts).

Die einzige Obergrenze ist das JSON-Body-Limit:

```ts
// packages/server/src/kernel/platform/http.ts:113
export async function readJson<T = unknown>(ctx: Ctx, limit = 8 * 1024 * 1024): Promise<T> {

// http.ts:98
if (size > limit) throw new HttpError(413, 'Payload too large', 'too_large');
```

**gemessen:**

- 2 MB Beschreibung → `200`, danach zurückgelesen: `stored description length: 2000000`.
- 10 MB Beschreibung → `413 {"error":"too_large","message":"Payload too large"}`.

Also: **Fehler, nicht Kürzung** — und der Schwellenwert ist der ganze Request-Body, nicht das Feld.
8 MB sind für einen Bug-Report weit jenseits von relevant; ein Limit auf SetAside-Seite wäre
trotzdem sinnvoll, damit ein durchgedrehter Stacktrace nicht als 413 zurückkommt.

---

## C. Attachments

### C11. Vertrag von `POST /api/workspaces/{ws}/files`

**Kein multipart, kein JSON+base64: der Rohkörper ist die Datei.** Der Docblock sagt, warum:

```ts
// packages/server/src/kernel/files/routes/files.ts:10-33
  /**
   * Raw-body upload: `POST /api/workspaces/:ws/files` with `content-type` and
   * `x-filename`. Deliberately not multipart — the browser client streams a
   * single blob, which keeps both sides tiny and makes retries trivial.
   */
  router.post('/api/workspaces/:ws/files', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    requireWorkspace(ctx, ctx.params.ws, 'member');
    if (!auth.scopes.has('write')) throw forbidden('Token is read-only');

    const mime = (ctx.req.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim();
    const name = decodeURIComponent(String(ctx.req.headers['x-filename'] ?? 'upload'));
    const body = await readBody(ctx.req, env.maxUploadBytes);
    if (!body.length) throw badRequest('Empty upload');

    return storeFile({
      workspaceId: ctx.params.ws,
      userId: auth.userId,
      name, mime, body,
      taskId: ctx.query.get('task_id'),
      pageId: ctx.query.get('page_id'),
      commentId: ctx.query.get('comment_id'),
      thumbUrl: ctx.query.get('thumb_url'),
    });
  });
```

**Request:**

| Teil | Wert |
|---|---|
| Methode/Pfad | `POST /api/workspaces/{ws}/files` |
| Body | die Bytes, roh, unverpackt |
| `content-type` | wird als MIME gespeichert; alles nach `;` fällt weg (`files.ts:20`) |
| `x-filename` | Dateiname, **URL-encodiert** (`files.ts:21`; Client: `sync/api.ts:110`) |
| `authorization` | `Bearer kol_…`; braucht `write` und Rolle ≥ `member` (`files.ts:17-18`) |
| `?task_id=` | optional — hängt die Datei direkt an den Task (`files.ts:29`) |
| `?page_id=`, `?comment_id=`, `?thumb_url=` | die anderen drei Ziele (`files.ts:30-32`) |

**Ein File pro Call.** Der Body *ist* die Datei; es gibt keine Mehrfachcodierung.

**Response** — `storeFile` (`uploads.ts:50-95`) gibt zurück:

```json
{"url":"/files/f272ceec…/screenshot.webp","hash":"f272ceec…",
 "name":"screenshot.webp","mime":"image/webp","size":46,"width":1280,"height":720,
 "attachment":{ … die vollständige serialisierte attachments-Zeile … }}
```

`width`/`height` erscheinen nur, wenn der Header lesbar war (`uploads.ts:68`, `...size` bei
`uploads.ts:91/94`); `attachment` nur, wenn ein Ziel angegeben war (`uploads.ts:82-92`).
Eine `id` für die *Datei* gibt es nicht — der `hash` ist die Identität (`schema.sql:1436`,
`PRIMARY KEY (hash, workspace_id)`).

Der Dateiname wird bereinigt, bevor irgendetwas damit passiert:

```ts
// packages/server/src/kernel/files/uploads.ts:21-22
export const safeName = (raw: string): string =>
  (raw || 'file').replace(/[\r\n"\\/]/g, '_').replace(/\.\./g, '_').slice(0, 180);
```

**gemessen** — `x-filename: %2E%2E%2Fetc%2F%22passwd%22.webp` wird zu `__etc__passwd_.webp`.
**gemessen** — ohne beide Header: `name: "upload"`, `mime: "application/x-www-form-urlencoded"`
(curls Default-Content-Type). Beide Header also immer setzen.

### C12. Wie wird die Datei zu einer `attachments`-Zeile am Task?

**Der Upload erledigt das, wenn man ihm `?task_id=` gibt.** Ein eigener
`POST /api/workspaces/{ws}/attachments` ist nicht nötig:

```ts
// packages/server/src/kernel/files/uploads.ts:80-92
  // Linking the blob to a task/page creates the attachment row that shows up
  // in the UI; a bare upload (e.g. an inline image) just returns the URL.
  if (input.taskId || input.pageId || input.commentId) {
    const { row } = writeEntity('attachment', uid(), {
      workspace_id: input.workspaceId,
      task_id: input.taskId ?? null, page_id: input.pageId ?? null, comment_id: input.commentId ?? null,
      name, mime: input.mime, size: input.body.length, url,
      thumb_url: input.thumbUrl ?? null,
      width: size?.width ?? null, height: size?.height ?? null,
      uploaded_by: input.userId,
    }, …);
    return { url, hash, name, mime: input.mime, size: input.body.length, ...size, attachment: serialize('attachment', row) };
  }
```

**Also: zwei Calls insgesamt** — Task anlegen, dann Upload mit `?task_id=`. Nicht drei.

Der Weg über `POST /api/workspaces/{ws}/attachments` existiert (die generische Create-Route,
`entities.ts:641`, Segment `attachments` aus `COLLECTIONS`,
`packages/shared/src/kernel/registry/entities.ts:708`) und funktioniert — **gemessen** mit
`{task_id, name, mime, size, url}` → `200`. Man braucht ihn aber nur, wenn man Bytes anhängen will,
die schon im Store liegen. Zwei Fallen dabei:

- **Ein fehlendes Pflichtfeld gibt 500, nicht 400.** `attachments.name` und `attachments.url` sind
  `NOT NULL` ohne Default (`schema.sql:887,890`), und die Constraint-Verletzung wird nicht
  abgefangen. **gemessen:** `{"task_id":"…","name":"nourl"}` → `500
  {"error":"internal_error","message":"Something went wrong"}`, im Log
  `ERR_SQLITE_ERROR / errcode 1299 / constraint failed`. Für die Fehlerklassifikation heißt das:
  hier sieht ein *permanenter* Fehler wie ein transienter aus (siehe [E23](#e23-ist-die-fehlerantwort-immer-error-message)).
- **`url` wird nicht validiert.** **gemessen:** `{"url":"https://evil.example/x.png"}` wird
  angenommen. Für SetAside irrelevant, aber es heißt: die `url` einer `attachments`-Zeile ist keine
  Zusicherung, dass die Bytes in Kolibri liegen.

### C13. Geht es in **einem** Call?

**Nein — Task und Anhang sind zwei Calls.** Es gibt keine Route, die einen Task samt Bytes anlegt:
`storeFile` verlangt eine bestehende `taskId` (`uploads.ts:31`), und der Task-Create nimmt keine
Anhänge entgegen (`entities.ts:641-674`, `work.ts:177-204`). Auch MCP trennt die beiden
(`create_task` in `tools/tasks.ts:160`, `upload_attachment` in `tools/attachments.ts:28`).

Das genannte Risiko ist aber **kleiner als befürchtet, und zwar auf beiden Seiten unterschiedlich:**

- **Der Task-Create ist idempotent**, wenn SetAside seine Report-UUID als `id` mitschickt — siehe
  [G25](#g25-idempotency-key). Ein Retry trifft denselben Task, es entsteht kein zweiter.
- **Der Upload ist es nicht.** `storeFile` dedupliziert die *Bytes* (`uploads.ts:60-66`), schreibt
  aber jedes Mal eine neue `attachments`-Zeile (`uploads.ts:82`, `uid()`).

**gemessen** — kompletter Happy Path, dann beide Calls unverändert wiederholt:

```
POST /tasks   (mit "id": <report-uuid>)   → 200   FB-2
POST /files?task_id=<report-uuid>          → 200   attachment c8dcedbd-…
--- Retry ---
POST /tasks   (identisch)                  → 200
POST /files?task_id=… (identische Bytes)   → 200
--- Ergebnis ---
Tasks mit dieser id:        1
Attachments an diesem Task: 2
```

Ein Retry erzeugt also **keinen doppelten Task, aber einen doppelten Anhang** — zweimal derselbe
Screenshot in der Files-Sektion, ein Blob auf der Platte. Das ist kosmetisch, nicht korrektheits-
relevant, und SetAside kann es billig vermeiden: vor dem Upload

```
GET /api/workspaces/{ws}/attachments?task_id=<report-uuid>
```

**gemessen:** liefert die Zeilen dieses Tasks (`task_id` ist ein Registry-Feld und damit
Filter-fähig, `entities.ts:547-555`). Ist eine mit dem erwarteten Namen da, ist der Upload schon
gelaufen.

**Was es kosten würde, es in einem Call zu machen:** wenig, und es gibt schon einen Präzedenzfall.
`create_tasks_batch` (`tools/tasks.ts:218`) fasst mehrere Writes in *eine* Transaktion — der
Kommentar bei `tools/tasks.ts:204-217` beschreibt exakt dieses Problem („can fail on the eleventh
and leave ten tasks behind"). Eine Route `POST /api/workspaces/{ws}/tasks` mit einem
`attachments: [{name, mime, content_base64}]`-Feld wäre `storeFile` in derselben `tx()` — die
Bausteine (`writeEntity`, `storeFile`, `tx`) liegen alle da. Schätzung: **ein Handler-Zweig, rund
40 Zeilen, plus ein Test.** Es ist eine Schätzung, keine Messung.

### C14. Limits und MIME-Allowlist

**Größe: 25 MB, konfigurierbar.**

```ts
// packages/server/src/kernel/platform/env.ts:339
maxUploadBytes: int(process.env.KOLIBRI_MAX_UPLOAD_MB, 25) * 1024 * 1024,
```

Durchgesetzt streamend in `readBody` (`http.ts:93-102`) → `413 too_large`.
**gemessen:** 26 MB → `413 {"error":"too_large","message":"Payload too large"}`.

Der aktuelle Wert ist unauthentifiziert abfragbar: `GET /api/config` gibt `maxUploadBytes` aus
(`routes/auth.ts:186-189`). SetAside kann ihn beim Start lesen, statt ihn zu raten.

**MIME-Allowlist beim Upload: es gibt keine.** Der Content-Type wird ungeprüft übernommen
(`files.ts:20`), und weder `storeFile` noch `writeEntity` filtern.
**gemessen:** `image/svg+xml` und `text/csv` werden beide mit `200` angenommen.

Eine Allowlist gibt es nur für die *Auslieferung*, und das ist die Stelle, an der es zählt:

```ts
// packages/server/src/kernel/files/mime.ts:16-23
export const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'application/pdf', 'text/plain', 'text/markdown', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg',
]);

export const disposition = (mime: string): { inline: boolean; type: string } =>
  (INLINE_TYPES.has(mime) ? { inline: true, type: mime } : { inline: false, type: 'application/octet-stream' });
```

**`image/webp` ist erlaubt** (`mime.ts:17`) und wird inline mit korrektem Content-Type ausgeliefert.
**gemessen** — Response-Header eines WebP:

```
content-type: image/webp
content-disposition: inline; filename="screenshot.webp"
cache-control: private, max-age=31536000, immutable
x-content-type-options: nosniff
```

Und zum Gegenbeweis, dass die Allowlist greift — **gemessen** mit dem hochgeladenen SVG:

```
content-type: application/octet-stream
content-disposition: attachment; filename="x.svg"
```

**WebP-Maße werden gelesen.** `imageSize` beherrscht VP8, VP8L und VP8X
(`packages/server/src/kernel/files/imagesize.ts:19-32`). **gemessen** — ein 1280×720-WebP kommt
mit `"width":1280,"height":720` zurück, in der Upload-Antwort *und* in der `attachments`-Zeile.
Das ist für SetAside nützlich: die UI reserviert damit Platz, der Screenshot springt nicht.

### C15. Ist die Ablage content-adressiert?

**Ja — SHA-256 über die Bytes.**

```ts
// packages/server/src/kernel/files/uploads.ts:52-53
const hash = createHash('sha256').update(input.body).digest('hex');
const key = storage.keyFor(hash, input.mime);
```

```ts
// packages/server/src/kernel/files/storage.ts:29-32
/** `<hash>` -> `ab/cd/<hash>.png`; the same key in both backends. */
export function keyFor(hash: string, mime: string): string {
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${EXTENSIONS[mime] ?? ''}`;
}
```

Dieselben Bytes zweimal → **eine Datei, eine `files`-Zeile pro Workspace, aber zwei
`attachments`-Zeilen.** Die Trennung ist ausdrücklich so gewollt, mit Narbe im Kommentar:

```ts
// uploads.ts:55-66
  // Two questions, and they used to be one. *Are these bytes already stored*
  // decides whether to write the blob; *does this workspace have a row for
  // them* decides whether to write the row. Answering only the first meant the
  // second workspace to upload a file got no row — and then a 403 reading back
  // what it had just sent.
```

**gemessen** — dieselben 28 Bytes dreimal hochgeladen, davon zweimal mit `?task_id=`:

```
hash:                       identisch (d11958780d4c…)
files-Zeilen für den hash:  1   (Name aus dem ERSTEN Upload: "shot.webp")
attachments-Zeilen am Task: 2
```

Zwei Dinge daran, die man wissen muss:

- **Der Name der `files`-Zeile ist der des ersten Uploads** (`uploads.ts:69`, `if (!mine)`), auch
  wenn spätere Uploads einen anderen `x-filename` mitschicken. Die `attachments`-Zeile und die
  zurückgegebene `url` tragen dagegen den *aktuellen* Namen (`uploads.ts:78`, `uploads.ts:86`).
  Beide URLs zeigen auf dieselben Bytes — der Pfad hinter dem Hash wird beim Lesen ignoriert,
  siehe C16.
- **Beim Löschen wird nur die Verknüpfung gelöst, nie der Blob** — dokumentiert in
  `tools/attachments.ts:162-175`: „Storage is content-addressed and shared […] deleting the blob
  here would take the file out from under somebody else."

### C16. Zugriffsschutz auf `GET /files/{hash}/{path}`

Das ist der Punkt, der die Datenschutz-Einordnung entscheidet, also hier vollständig und gemessen.

**Authentifiziert: ja. Kenntnis der URL reicht nicht.**

```ts
// packages/server/src/kernel/files/routes/files.ts:36-43
  router.get('/files/:hash/*', async (ctx: Ctx) => {
    const auth = requireAuth(ctx);
    // A hash can belong to more than one workspace. The question is whether it
    // belongs to one of *yours*, not whether the first row happens to be.
    const rows = all<Row>(`SELECT * FROM files WHERE hash = ?`, ctx.params.hash);
    if (!rows.length) throw notFound('File not found');
    const file = rows.find((row) => auth.memberships.has(String(row.workspace_id)));
    if (!file) throw forbidden('Not your workspace');
```

**gemessen:**

| Aufruf | Ergebnis |
|---|---|
| ohne `authorization` | `401 {"error":"unauthorized",…}` |
| mit `read`-Token | `200` (Lesen braucht kein `write`) |
| unbekannter Hash | `404 {"error":"not_found","message":"File not found"}` |
| falscher Dateiname im Pfad (`/files/<hash>/beliebig.webp`) | `200` — der Pfad hinter dem Hash ist Dekoration |

**Der Hash ist aus dem Inhalt ableitbar** — SHA-256 der Bytes (`uploads.ts:52`). Wer die Bytes hat,
kann die URL ausrechnen; wer sie nicht hat, kann sie nicht raten. Für Screenshots ohne Bedeutung.

**Aber — und das ist die eigentliche Antwort:** die Prüfung ist auf **Workspace**-Ebene, nicht auf
Projektebene. `auth.memberships` (`auth.ts:86-92`) kennt nur Workspace-Mitgliedschaften; ein
`canSeeProject` kommt in `files.ts` nicht vor. Dieselbe Lücke hat die REST-Attachment-Liste, weil
`attachments` gar kein `project_id` hat (`packages/shared/src/kernel/registry/entities.ts:428-434`)
und der Projektfilter deshalb ins Leere greift:

```ts
// packages/server/src/kernel/write-path/routes/entities.ts:34-35
const projectOf = (entity: EntityName, row: Row): string | null =>
  (entity === 'project' ? row.id : row.project_id) ?? null;

// entities.ts:616
.filter((row) => canSeeProject(auth.userId, projectOf(entity, row)))
```

Für eine `attachments`-Zeile ist `row.project_id` `undefined` → `null` → und `canSeeProject`
gibt bei `null` `true` zurück (`repo.ts:859`, `if (!projectId) return true;`).

Der Sync-Pfad macht es richtig und zeigt damit, wie es gemeint war:

```sql
-- packages/server/src/kernel/sync/routes/sync.ts:315-318
    case 'comment':
    case 'attachment':
      return `AND (${table}.task_id IS NULL OR EXISTS (
                SELECT 1 FROM tasks t WHERE t.id = ${table}.task_id AND t.project_id IN (…)))`;
```

**gemessen** — Aufbau: privates Projekt `FB` (`visibility: "private"`), Task darin, Screenshot
daran. Alan ist Workspace-Mitglied, aber **kein** Projektmitglied. Alle Aufrufe mit Alans Token:

| Aufruf | Ergebnis |
|---|---|
| `GET /api/tasks/<fb-task-id>` | **403** — korrekt geschützt |
| `GET /api/workspaces/{ws}/tasks?project_id=<fb>` | `[]` — korrekt gefiltert |
| `GET /api/workspaces/{ws}/projects` | `["WEB","API","MOB"]` — `FB` fehlt, korrekt |
| `GET /api/workspaces/{ws}/attachments` | **liefert die Zeile inkl. `url`** |
| `GET /api/workspaces/{ws}/files` | **listet `kundendaten.webp`** |
| `GET /files/<hash>/kundendaten.webp` | **200 — die Bytes** |
| `POST /files?task_id=<fb-task-id>` | **200 — er kann sogar hineinschreiben** |

**Einordnung, ohne Ausschmückung:** die Datei ist nicht frei per URL abrufbar — jede Anfrage braucht
ein gültiges Token. Sie ist aber **für jedes Mitglied des Workspace abrufbar**, unabhängig davon,
ob die Person den Task oder das Projekt sehen darf. Die Projektprivatsphäre schützt den Task und
seinen Text; sie schützt den Anhang nicht.

Für SetAside heißt das: der Kreis, der die Screenshots sehen kann, ist der **Workspace**, nicht das
Projekt. Wenn dieser Kreis kleiner sein soll als „alle Kolibri-Nutzer der Firma", muss die Grenze
ein eigener Workspace sein — siehe [H27](#h27-beschränkt-projekt-mitgliedschaft-die-sichtbarkeit)
und [H28](#h28-empfohlenes-setup).

Zwei Randnotizen:

- Mit Object-Store statt Platte wird stattdessen ein kurzlebiger signierter Redirect ausgegeben
  (`files.ts:50-57`, `storage.ts:120-127`), `cache-control: private, max-age=60`. Die
  Berechtigungsprüfung liegt davor — dieselbe wie oben, also mit derselben Grenze.
- Der `content-disposition`-Filter aus C14 gilt auch für die signierte URL; der Kommentar bei
  `mime.ts:9-14` beschreibt genau den Fehler, der einmal dadurch entstand.

---

## D. Auth & Tokens

### D17. Wie wird ein Token erzeugt? Welche Scopes?

**UI:** Einstellungen → *API & MCP*, also `/settings?tab=api`
(`packages/web/src/modules/operations/routes/settings.tsx:36,45-48`; Route `App.tsx:260`).
Der Screen bietet nur ein Namensfeld (`settings.tsx:899-908`) und schickt
`{name, workspaceId}` ohne `scopes` — die UI erzeugt also immer `read,write`.

**Endpoint:**

```ts
// packages/server/src/kernel/identity/routes/auth.ts:499-513
  router.post('/api/tokens', async (ctx) => {
    const auth = requireAuth(ctx);
    const body = await readJson<{ name?: string; workspaceId?: string; scopes?: string; expiresInDays?: number }>(ctx);
    if (body.workspaceId) requireWorkspace(ctx, body.workspaceId);
    const raw = `kol_${token(24)}`;
    …
      (body.scopes ?? 'read,write'), Date.now(),
      body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null,
    );
    return { id, token: raw, name: body.name ?? 'API token' };
```

Dazu `GET /api/tokens` (`routes/auth.ts:489`) und `DELETE /api/tokens/:id`
(`routes/auth.ts:515-519`, setzt `revoked_at`). Ein dritter Weg ist OAuth — der Connector-Flow mintet
Tokens in dieselbe Tabelle (`adapters/oauth/routes/oauth.ts:441-449`).

**Scopes: es gibt genau zwei Stufen, und nur eine davon wird geprüft.**

`scopes` ist ein freier Komma-String (`schema.sql:92`, `DEFAULT 'read,write'`). Ein
`grep -rno "scopes\.has('[a-z]*')"` über `packages/server/src` liefert **19 Treffer, alle
`'write'`** — 18 in REST-Handlern, einer in `mcp/kit.ts:693`. `'read'` wird nirgends abgefragt.
Der OAuth-Flow kennt dieselben zwei Namen (`oauth.ts:131,144,374`).

Das heißt: **`read` ist kein Recht, sondern die Abwesenheit von `write`.**
**gemessen** — Token mit `scopes: "write"` (ohne `read`):

```
GET  /api/workspaces/{ws}/tasks  → 200
POST /api/workspaces/{ws}/tasks  → 200
```

Ein unbekannter Scope-String verhält sich wie `read`, weil `write` fehlt. Eine feinere Abstufung —
etwa „darf Tasks anlegen, aber keine Budgets lesen" — existiert nicht.

**Wichtiger Nebenbefund, gemessen:** `POST /api/tokens` ruft nur `requireAuth` auf, nicht
`requireWrite` (`routes/auth.ts:500`). **Ein `read`-Token kann sich also ein `read,write`-Token
ausstellen:**

```
POST /api/tokens  (mit dem read-Token)  →  200 {"id":"da7dee55-…","token":"kol_5xOU…"}
```

`read` ist damit keine Sicherheitsgrenze, sondern eine Selbstbeschränkung. Für SetAside ohne
Konsequenz — es braucht ohnehin `write` — aber es entwertet den Satz aus `openapi.json`
(„A `read` token is refused on every write") als Schutzaussage: er stimmt wörtlich und trägt nicht.

### D18. Deckt ein Write-Token alle drei Operationen ab?

**Ja. Ein einziges `write`-Token genügt für alle drei.** Es ist überall exakt dieselbe Prüfung —
`auth.scopes.has('write')` — plus die Workspace-Rolle:

| Operation | Prüfung | Fundstelle |
|---|---|---|
| Task anlegen | `write` + Rolle ≥ `member` (Gäste nur für `isGuestWritable`) | `entities.ts:644,649` |
| Datei hochladen | `write` + Rolle ≥ `member` | `files.ts:17-18` |
| Attachment verknüpfen | dieselbe Create-Route wie der Task | `entities.ts:644` |

Beim Upload steht die Rollenprüfung sogar strenger da als beim Create: `files.ts:17` verlangt
`'member'` direkt in `requireWorkspace`, während `entities.ts:643` mit `guest` einsteigt und die
Rolle erst danach prüft. Ergebnis identisch.

**gemessen** — die Vikunja-Falle existiert hier nicht:

```
read-Token,  POST /tasks  → 403 {"error":"forbidden","message":"Token is read-only"}
read-Token,  POST /files  → 403 {"error":"forbidden","message":"Token is read-only"}
write-Token, POST /tasks  → 200
write-Token, POST /files  → 200
write-Token, POST /attachments → 200
```

Getrennte Rechte für Upload gibt es nicht — ein Token, das Tasks anlegen darf, darf hochladen.

### D19. Lässt sich ein Token einschränken?

**Auf ein Projekt: nein. Auf einen Workspace: nein — trotz der Spalte.**

`api_tokens` *hat* eine `workspace_id` (`schema.sql:88`), und `POST /api/tokens` füllt sie
(`routes/auth.ts:508`). Sie wird beim Authentifizieren aber gar nicht erst gelesen:

```ts
// packages/server/src/kernel/identity/auth.ts:140-145
const apiToken = get<{ id: string; user_id: string; scopes: string; expires_at: number | null; revoked_at: number | null }>(
  `SELECT id, user_id, scopes, expires_at, revoked_at FROM api_tokens WHERE token_hash = ?`, hash,
);
if (apiToken && !apiToken.revoked_at && (!apiToken.expires_at || apiToken.expires_at > now)) {
  run(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, now, apiToken.id);
  return build(apiToken.user_id, apiToken.scopes.split(','), apiToken.id);
```

`workspace_id` steht nicht in der `SELECT`-Liste. `build` (`auth.ts:166-179`) setzt
`memberships: loadMemberships(userId)` — **alle** Workspaces des Eigentümers. Ein REST-Token hat
also genau die Reichweite seines Menschen.

Gelesen wird die Spalte an genau einer Stelle, und dort als *Voreinstellung*:

```ts
// packages/server/src/adapters/mcp/routes/mcp.ts:104-111
function contextFor(ctx: Ctx): McpCtx {
  …
  const pinned = auth.tokenId
    ? get<Row>(`SELECT workspace_id FROM api_tokens WHERE id = ?`, auth.tokenId)?.workspace_id ?? null
    : null;
  return { auth, defaultWorkspace: pinned };
```

Und die MCP-Auflösung nimmt ein explizites Argument vorrangig:

```ts
// packages/server/src/adapters/mcp/kit.ts:60-65
const explicit = str(args.workspace_id) ?? ctx.defaultWorkspace ?? undefined;
if (explicit) {
  if (!ctx.auth.memberships.has(explicit)) throw new McpError(`Not a member of workspace ${explicit}`);
  return explicit;
}
```

Das Repository sagt das selbst, ausdrücklich und an zwei Stellen — es ist kein Versehen, sondern
eine benannte Entscheidung:

```ts
// packages/web/src/modules/operations/tokens.ts:29-36
   * Defaults to a workspace this person can see, and here is its name.
   *
   * A default, measured — not a boundary. A call that names `workspace_id`
   * itself is answered for *that* workspace, and the only gate is the owner's
   * membership (`workspaceOf` in the MCP kit). So this label says where the
   * token points, never what it is confined to.
```

```
// packages/web/src/kernel/i18n/locales/de.ts:1996
'api.tokenBoundTo': 'Neue Tokens sind auf {workspace} voreingestellt: Aufrufe, die selbst
                     keinen Workspace nennen, landen dort. […]'
```

**Konsequenz für SetAside:** der Wunsch „SetAsides Token soll nicht das ganze Kolibri lesen können"
ist mit den heutigen Mitteln **nur über den Kontoschnitt erfüllbar** — ein eigener Benutzer, der
ausschließlich im Feedback-Workspace Mitglied ist, und dessen Token. Ein Token allein grenzt nichts
ein. Siehe [H28](#h28-empfohlenes-setup) und den Änderungsvorschlag am Ende.

### D20. Token-Format, Header, Ablauf, Rotation

| | |
|---|---|
| Format | `kol_` + 24 Byte Base64url = **36 Zeichen** (`routes/auth.ts:503`; **gemessen:** `len 36`) |
| Header | `Authorization: Bearer kol_…` (`auth.ts:128-131`) |
| Alternative | `?access_token=…` im Query — **nur für SSE gedacht** (`auth.ts:132`). Nicht benutzen: landet in Proxy-Logs. |
| Speicherung | nur der Hash, `sha256(token + KOLIBRI_SECRET)` (`auth.ts:32-33`) |
| Ausgabe | genau einmal, beim Anlegen (`routes/auth.ts:498`) |
| Ablauf | optional, `expiresInDays` (`routes/auth.ts:510`); ohne Angabe `expires_at = NULL` = **nie** |
| Prüfung | `!expires_at \|\| expires_at > now` (`auth.ts:143`) |
| Widerruf | `DELETE /api/tokens/:id` setzt `revoked_at` (`routes/auth.ts:517`) |
| Rotation | **keine** — es gibt keinen Refresh-Endpoint für API-Tokens |
| `last_used_at` | wird bei jeder Anfrage geschrieben (`auth.ts:144`) — brauchbar für ein Monitoring |

**gemessen** — `{"name":"kurz","scopes":"write","expiresInDays":1}` → Token mit
`expires_at: 1789041239588`; ohne das Feld → `expires_at: null`.

Rotation heißt hier: neues Token anlegen, umstellen, altes widerrufen. Da ein Token sich selbst
Nachfolger ausstellen darf (siehe D17), kann SetAside das sogar automatisieren — ob man das *will*,
ist eine andere Frage. `last_used_at` sagt danach, ob das alte noch irgendwo hängt.

Der OAuth-Weg hat sehr wohl Refresh-Tokens (`oauth.ts:400-405`, Rotation bei Gebrauch), aber der ist
für interaktive Connector-Anbindung gedacht, nicht für einen Worker.

---

## E. Fehlerverhalten

### E21. Statuscodes

Alle Zeilen **gemessen**, Fundstelle daneben. „P/T" ist die Empfehlung für die
permanent/transient-Klassifikation.

| Situation | Status | Body | Fundstelle | P/T |
|---|---|---|---|---|
| kein Token | `401` | `{"error":"unauthorized","message":"Authentication required"}` | `http.ts:15` | **P** |
| ungültiges/widerrufenes/abgelaufenes Token | `401` | dito | `auth.ts:143,154`, `http.ts:15` | **P** |
| `read`-Token schreibt | `403` | `{"error":"forbidden","message":"Token is read-only"}` | `entities.ts:644`, `files.ts:18` | **P** |
| `read`-Token lädt hoch | `403` | dito | `files.ts:18` | **P** |
| unbekannter/fremder Workspace | `403` | `{"error":"forbidden","message":"You are not a member of this workspace"}` | `auth.ts:189` | **P** |
| Workspace als Slug statt UUID | `403` | dito | `auth.ts:186-189` | **P** |
| Rolle zu niedrig (Gast) | `403` | `{"error":"forbidden","message":"Guests cannot create content"}` | `entities.ts:649` | **P** |
| privates Projekt, nicht Mitglied | `403` | `{"error":"forbidden","message":"Project is private"}` | `entities.ts:38` | **P** |
| unbekanntes / fremdes Projekt | `400` | `{"error":"bad_request","message":"task.project_id must reference an existing project"}` | `work.ts:180` | **P** |
| unbekannte Collection | `404` | `{"error":"not_found","message":"Unknown collection widgets"}` | `entities.ts:23` | **P** |
| unbekannte Task-ID | `404` | `{"error":"not_found","message":"task not found"}` | `entities.ts:29` | **P** |
| unbekannter Datei-Hash | `404` | `{"error":"not_found","message":"File not found"}` | `files.ts:41` | **P** |
| kaputtes JSON | `400` | `{"error":"bad_request","message":"Invalid JSON body"}` | `http.ts:128` | **P** |
| `content-type: multipart/form-data` o. ä. | `415` | `{"error":"unsupported_media_type","message":"Send this as application/json"}` | `http.ts:119-121` | **P** |
| Body > 8 MB (JSON) | `413` | `{"error":"too_large","message":"Payload too large"}` | `http.ts:98` | **P** |
| Datei > `maxUploadBytes` | `413` | dito | `http.ts:98`, `files.ts:22` | **P** |
| leerer Upload | `400` | `{"error":"bad_request","message":"Empty upload"}` | `files.ts:23` | **P** |
| Route existiert nicht | `404` | `{"error":"not_found","message":"No route for POST /x"}` | `index.ts:221` | **P** |
| NOT-NULL-Verletzung (z. B. `attachment` ohne `url`) | **`500`** | `{"error":"internal_error","message":"Something went wrong"}` | `index.ts:253-254` | **P**, sieht aber transient aus |
| Zielsystem aus, Netzwerk weg | — | keine Antwort | — | **T** |

Die vorletzte Zeile ist die einzige echte Falle: **ein `500` ist hier nicht zuverlässig transient.**
Details unter E23.

### E22. Rate-Limiting

**Auf dem SetAside-Pfad gibt es keins.**

Der Limiter existiert und ist ordentlich gebaut (`packages/server/src/kernel/identity/ratelimit.ts`),
wird aber nur von Credential- und öffentlichen Routen aufgerufen. Die Aufruferliste vollständig
(`grep -rn "import.*ratelimit"`):

```
kernel/identity/routes/auth.ts     adapters/oauth/routes/oauth.ts
kernel/identity/routes/workspaces.ts  adapters/share/routes/share.ts
modules/ai-review/routes/ai.ts     adapters/mail/routes/mail.ts
adapters/webhooks/routes/inbound.ts   adapters/calendar/routes/calendar.ts
```

`entities.ts` und `files.ts` sind nicht dabei. Die konfigurierten Buckets
(`ratelimit.ts:82-123`) sind `login`, `register`, `oauthClient`, `invite`, `password`, `intake` —
keiner davon deckt Task-Create oder Upload.

**gemessen:**

```
40 × POST /api/workspaces/{ws}/tasks   → 40 × 200, kein 429
30 × POST /api/workspaces/{ws}/files   → 30 × 200, kein 429
14 × POST /api/auth/login (falsch)     → 10 × 401, dann 4 × 429   ← zum Gegenbeweis
```

**Wenn ein `429` kommt, trägt es `Retry-After` in Sekunden:**

```ts
// packages/server/src/kernel/identity/ratelimit.ts:252-254
const seconds = Math.max(...refused.map((result) => result.check.limit.everySeconds));
ctx.res.setHeader('retry-after', String(seconds));
throw new HttpError(429, `Too many attempts — wait ${seconds} seconds and try again`, 'rate_limited');
```

**gemessen** — `HTTP/1.1 429`, `retry-after: 30`.

`429` ist also **transient mit vom Server genanntem Wartewert**. SetAside sollte `Retry-After` lesen
statt den eigenen Backoff zu nehmen — auch wenn der Fall auf diesem Pfad heute nicht auftritt, kann
ein Reverse-Proxy vor Kolibri denselben Status liefern.

### E23. Ist die Fehlerantwort immer `{error, message}`?

**Ja, mit einer Ausnahme in der Sache und keiner in der Form.**

Ein Punkt im Server serialisiert alle Fehler:

```ts
// packages/server/src/index.ts:244-255
  } catch (err) {
    if (res.headersSent) { res.end(); return; }
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.code ?? 'error', message: err.message });
      return;
    }
    log('error', `${req.method} ${url.pathname} failed`, err);
    send(res, 500, { error: 'internal_error', message: 'Something went wrong' });
  }
```

Das gilt **auch für die handgeschriebenen Routen** — `files.ts` wirft `HttpError` und schreibt keine
eigenen Fehlerantworten (`files.ts:23,41,43,60`). Auch die 404-Fälle vor dem Routing
(`index.ts:221`) und die MCP-405 (`mcp/routes/mcp.ts:97-100`) halten die Form ein.
`grep -rn "send(res, 4\|send(res, 5\|send(ctx.res, 4\|send(ctx.res, 5"` findet genau diese drei
Stellen, alle konform. `openapi.json` beschreibt dasselbe (`components.schemas.Error`, `required:
["error"]`).

**Die Slug-Liste ist stabil, aber nicht formal veröffentlicht.** Fünf kommen aus Konstruktoren:

```ts
// packages/server/src/kernel/platform/http.ts:14-18
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');
export const unauthorized = (m = 'Authentication required') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Not allowed') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
```

Die übrigen werden direkt konstruiert. Vollständige Menge im Server, per
`grep -rhno "new HttpError([0-9]*, [^)]*'[a-z_]*')"` plus die fünf oben:

```
bad_request  conflict  forbidden  hook_test_failed  internal_error  invalid_redirect_uri
not_found  rate_limited  too_large  totp_required  unauthorized  unsupported_media_type
```

Elf davon sind stabil; `internal_error` ist der Sammelpunkt. Eine kanonische Liste an einer Stelle
im Code gibt es **nicht** — sie ist über die Konstruktionsstellen verteilt. SetAside sollte deshalb
**auf den Status abbilden und den Slug nur zur Verfeinerung nehmen.**

**Der eine Fall, in dem `500` nicht transient ist:** eine SQLite-Constraint-Verletzung fällt in den
`catch`-Zweig bei `index.ts:253`, weil sie kein `HttpError` ist. **gemessen:**

```
POST /api/workspaces/{ws}/attachments  {"task_id":"…","name":"nourl"}
→ 500 {"error":"internal_error","message":"Something went wrong"}
Log: ERR_SQLITE_ERROR  errcode 1299  errstr 'constraint failed'
```

Fünf Retries ändern daran nichts. Der Vorschlag für die Klassifikation:

```
401, 403, 404, 413, 415, 400   → permanent
429                            → transient, Retry-After beachten
5xx                            → transient, ABER mit Attempt-Budget ≤ 2 und einem
                                 Deadletter-Pfad; auf diesem Server ist ein 500 im
                                 Zweifel ein Programmierfehler im Request, kein Ausfall
Netzwerk / Timeout             → transient
```

Weil SetAside den Task idempotent anlegen kann (G25), sind Retries auf 5xx billig — der
Wiederholungsversuch trifft entweder denselben Task oder legt ihn erstmals an.

---

## F. Backlink

### F24. Frontend-URL-Muster für einen Task

**`{KOLIBRI_PUBLIC_URL}/t/{id}` — und `{identifier}` funktioniert genauso.**

```tsx
// packages/web/src/App.tsx:271
<Route path="/t/:id" element={<TaskRoute />} />
```

```ts
// packages/web/src/kernel/design-system/navigation.ts:29-45
/**
 * The task a `/t/...` link names, whether that is a row id or `WEB-42`.
 *
 * Both are worth supporting for the same reason: the id is what the app links
 * to internally and never changes, and the identifier is what people actually
 * write — in a chat message, in a commit, in a note to themselves. […]
 */
export function useTaskRef(ref: string): string {
  return useQuery(
    () => (byId('task', ref) ? ref : list('task', (task) => task.identifier === ref)[0]?.id ?? ref),
    [ref],
  );
}
```

**Kein Workspace-Präfix.** Der Server baut denselben Link an zwei Stellen:

```ts
// packages/server/src/adapters/telegram/telegram.ts:241
if (row.task_id) return `${env.publicUrl}/t/${row.task_id}`;

// packages/server/src/adapters/webhooks/effects.ts:136-138
url: env.publicUrl ? row.task_id ? `${env.publicUrl}/t/${row.task_id}` : …
```

Die Basis ist `KOLIBRI_PUBLIC_URL` (`packages/server/src/kernel/platform/env.ts:336`, trailing Slash
wird abgeschnitten).

**Empfehlung: `/t/{id}` speichern, `{identifier}` anzeigen.** Die `id` ist stabil und kennt SetAside
ohnehin (es hat sie ja selbst vergeben, siehe G25); der `identifier` ändert sich, wenn jemand den
Projekt-Key umbenennt — die Regel dafür steht in `work.ts:337-351`, samt der Begründung, warum ein
Key eindeutig sein muss. Ein gespeicherter `identifier`-Link zeigt dann ins Leere, ein
`id`-Link nicht.

Auflösung serverseitig, falls SetAside doch mal von `FB-12` auf die UUID kommen muss:
`GET /api/workspaces/{ws}/by-identifier/FB-12` (`entities.ts:797-806`; der Identifier wird
groß geschrieben, `entities.ts:801`).

---

## G. Idempotenz

### G25. Idempotency-Key

**Es gibt keinen `Idempotency-Key`-Header — aber es braucht auch keinen: der Create ist ein Upsert
über ein selbstgewähltes `id`-Feld.**

```ts
// packages/server/src/kernel/write-path/routes/entities.ts:667-673
const id = typeof body.id === 'string' ? body.id : uid();
const { row } = writeEntity(entity, id, { ...body, workspace_id: ctx.params.ws }, {
  workspaceId: ctx.params.ws,
  actorId: auth.userId,
  hlc: serverClock.now(),
});
return serialize(entity, row);
```

`writeEntity` verzweigt auf die Existenz der Zeile (`repo.ts:98,101`) und macht daraus ein `INSERT`
oder ein `UPDATE` (`repo.ts:158-160`). Zwei Eigenschaften machen das für einen Retry brauchbar:

- **`applyCreateDefaults` läuft nur beim ersten Mal** (`repo.ts:148`, `created ? … : {}`).
  `identifier`, `number` und `created_at` bleiben deshalb, was sie beim ersten Call waren — ein
  Retry verbrennt keine zweite Nummer aus `projects.next_number`.
- **`id` selbst kann nicht überschrieben werden**: `writable` wird aus `def.fields` gebaut
  (`repo.ts:103`), und `id` steht dort nicht (`packages/shared/src/kernel/registry/entities.ts:181-191`).
  Das `id` im Body wirkt nur als Adresse, nie als Wert.

**gemessen** — derselbe Body mit `"id": "11111111-2222-4333-8444-555555555555"`, zweimal:

```
try 1 -> 11111111-…  WEB-13  'idempotent try 1'  created_at 1788954725247
try 2 -> 11111111-…  WEB-13  'idempotent try 2'  created_at 1788954725247
Tasks mit dieser id: 1
```

Also: **derselbe Task, dieselbe Nummer, dasselbe `created_at`** — nur die Felder des zweiten
Requests haben gewonnen (Last-Writer-Wins per Feld, `repo.ts:113-128`), was bei einem
unveränderten Retry gerade nichts ändert.

**Empfehlung:** SetAside schickt seine Report-UUID als `id`. Damit ist der Task-Create
retry-sicher, und der Backlink steht schon vor dem ersten Call fest — das vereinfacht die
Fehlerbehandlung genau so, wie die Frage es vermutet.

Drei Einschränkungen, die dazugehören:

1. **Der Upload bleibt nicht-idempotent** (siehe C13). Wenn Duplikate stören, vorher
   `GET /api/workspaces/{ws}/attachments?task_id=<report-uuid>` prüfen.
2. **Der Response sagt nicht, ob angelegt oder aktualisiert wurde.** `writeEntity` liefert
   `created` (`repo.ts:31-34,164`), aber der Handler gibt nur `serialize(entity, row)` zurück
   (`entities.ts:673`). Ein Client kann „neu" von „getroffen" nur an `created_at` unterscheiden.
   Statuscode ist in beiden Fällen `200`, nie `201`.
3. **Die ID muss eine echte UUIDv4 sein.** Ein geratener oder abgeleiteter Wert könnte eine
   bestehende Zeile treffen — die Create-Route prüft nicht, ob eine schon existierende ID im selben
   Workspace liegt (`entities.ts:641-674` hat kein `workspaceOf`). `workspace_id` selbst ist
   geschützt (`repo.ts:111`, wird für Nicht-System-Writes aus `writable` entfernt) und
   `guardReferences` (`repo.ts:216-234`) verhindert workspace-übergreifende Verweise, aber der
   sichere Weg ist schlicht eine zufällige UUID. SetAside hat die.

### G26. Auffinden über ein Fremdschlüssel-Feld

**Ein `external_ref`-Feld gibt es nicht** — `tasks` hat keine solche Spalte (`schema.sql:693-726`)
und die Registry kein solches Feld
(`packages/shared/src/kernel/registry/entities.ts:181-191`). Custom Fields (`field`/`fieldValue`)
existieren, sind aber nicht filterbar: der Query-Filter läuft nur über `def.fields` der
*gefragten* Collection (`entities.ts:547-555`).

**Der brauchbare Ersatz ist G25 selbst:** wenn die Report-UUID die Task-`id` ist, ist
„gibt es schon einen Task mit external_ref = X?" gleichbedeutend mit

```
GET /api/tasks/<report-uuid>     →  200 = ja   |   404 = nein
```

**gemessen:** unbekannte UUID → `404 {"error":"not_found","message":"task not found"}`. Ohne
Volltextsuche, ein Call.

**Was nicht funktioniert und leise falsch aussieht:** Filter über Query-Parameter, die keine
Registry-Felder sind, werden **stillschweigend ignoriert**. Die Schleife bei `entities.ts:547-549`
überspringt unbekannte Namen, ohne zu widersprechen.

**gemessen:**

```
GET /api/workspaces/{ws}/tasks?external_ref=abc   → 200, ALLE Tasks
GET /api/workspaces/{ws}/tasks?id=<uuid>          → 200, ALLE 26 Tasks
```

Das zweite ist der Fußangel-Fall: `id` sieht wie ein Feld aus, steht aber nicht in `def.fields` und
filtert deshalb nicht. Ein Client, der `?id=` als Existenzprüfung benutzt, bekommt immer ein
nicht-leeres Ergebnis. Für Existenzprüfungen also `GET /api/tasks/{id}` nehmen, nicht die Liste.

Filterbar sind dagegen alle echten Registry-Felder — `?project_id=`, `?state_id=`, `?priority=`,
und für Attachments `?task_id=` (in C13 gemessen). `?feld=null` filtert auf `IS NULL`
(`entities.ts:550`).

---

## H. Projekt-Setup & Sichtbarkeit

### H27. Beschränkt Projekt-Mitgliedschaft die Sichtbarkeit?

**Für Tasks: ja, sauber. Für Anhänge und deren Bytes: nein.**

Die Regel selbst ist eindeutig und an einer Stelle:

```ts
// packages/server/src/kernel/write-path/repo.ts:858-869
export function canSeeProject(userId: string, projectId: string | null | undefined): boolean {
  if (!projectId) return true;
  const project = get<Row>(`SELECT workspace_id, visibility FROM projects WHERE id = ?`, projectId);
  if (!project) return false;
  const member = get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deleted_at IS NULL`,
    project.workspace_id, userId,
  );
  if (!member) return false;
  if (project.visibility === 'public') return true;
  return !!get(`SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND deleted_at IS NULL`, projectId, userId);
}
```

Zwei Bedingungen also: Workspace-Mitglied **und** (Projekt öffentlich **oder** Projekt-Mitglied).
„Public" heißt dabei „alle im *eigenen* Workspace" — der Docblock bei `repo.ts:842-857` erzählt den
Bug, der das klargestellt hat.

Das Ergebnis der Messung steht schon in [C16](#c16-zugriffsschutz-auf-get-fileshashpath), hier
noch einmal auf die Frage zugeschnitten. Alan: Workspace-Mitglied, **kein** Projektmitglied im
privaten Projekt `FB`.

| | sieht Alan es? | warum |
|---|---|---|
| Task `FB-1` einzeln | **nein** (403) | `guardProject`, `entities.ts:37-39` |
| Task in der Liste | **nein** | `canSeeProject`-Filter, `entities.ts:616` |
| Projekt `FB` in der Projektliste | **nein** | derselbe Filter |
| Task über Sync | **nein** | `projectFilter`, `sync.ts:280` ff. |
| **`attachments`-Zeile (REST-Liste)** | **ja** | `attachments` hat kein `project_id` → `projectOf` = `null` → `canSeeProject(…, null) === true` (`entities.ts:34-35`, `repo.ts:859`) |
| **`files`-Zeile (Workspace-Dateiliste)** | **ja** | `files.ts:75-82` filtert nur auf `workspace_id` |
| **die Bytes, `GET /files/<hash>/…`** | **ja (200)** | `files.ts:42` prüft nur `auth.memberships` |
| Anhang über Sync | **nein** | `sync.ts:315-318` prüft das Projekt des Tasks |

Die Antwort auf die Frage, wie sie gestellt war — „sehen Workspace-Mitglieder ohne
Projekt-Mitgliedschaft die Tasks **und deren Anhänge** nicht?" — lautet also: **die Tasks nicht,
die Anhänge doch.** Die Absicherung, auf die SetAside sich stützen wollte, trägt für den Screenshot
nicht.

Dass der Sync-Pfad es richtig macht, ist der beste Beleg dafür, dass es eine Lücke und keine
Entscheidung ist: dieselbe Frage wird an zwei Stellen unterschiedlich beantwortet.

### H28. Empfohlenes Setup

**Ein eigener Workspace für Feedback** — nicht ein privates Projekt im bestehenden.

Die Begründung ist keine Vorliebe, sondern folgt direkt aus H27/C16: **die einzige Grenze, die für
Dateibytes tatsächlich durchgesetzt wird, ist die Workspace-Mitgliedschaft** (`files.ts:42`). Ein
privates Projekt schützt Tasks; es schützt keine Screenshots. Wenn diese Screenshots Kunden-, Lead-
und Gehaltsdaten enthalten, muss die Grenze dort verlaufen, wo sie wirklich geprüft wird.

Konkret:

1. **Workspace anlegen** — `POST /api/workspaces` mit `{name: "Feedback"}`
   (`workspaces.ts:27-33`). Mitglieder: nur wer die Screenshots sehen darf. Achtung: die Route
   legt ungefragt ein Projekt `GET` („Getting started") mit an (`workspaces.ts:32`) — entweder
   löschen oder gleich als Feedback-Projekt benutzen.
2. **Ein Benutzerkonto „SetAside"** anlegen und **nur** diesem Workspace hinzufügen. Das ist die
   Ersatzhandlung für das fehlende Token-Scoping (D19): die Reichweite des Tokens ist die
   Reichweite seines Kontos, also wird das Konto klein gehalten. Ein Token an Adas Konto würde
   ganz Kolibri lesen können.
3. **Projekt darin anlegen** — `POST /api/workspaces/{ws}/projects` mit
   `{name, key: "FB", visibility: "private"}`. Der Create-Pfad (`entities.ts:653-665` →
   `bootstrap.ts:143`) legt States und Labels gleich mit an (`bootstrap.ts:176-188`), setzt
   `default_state_id` (womit A1 greift) und macht den Ersteller zum `projectMember` mit Rolle
   `lead` (`bootstrap.ts:173-174`). **gemessen:** ein so angelegtes Projekt lieferte beim ersten
   Task sofort ein `state_id`.
4. **Token für das SetAside-Konto**, gebunden an diesen Workspace — die Bindung ist zwar nur eine
   Voreinstellung (D19), aber sie kostet nichts und sie macht die Absicht in `GET /api/tokens`
   sichtbar. Mit `expiresInDays`, damit Rotation eine Fälligkeit hat statt eines Vorsatzes.
5. **`visibility: "private"` trotzdem setzen.** Es schützt den Task-Text gegen künftige
   Workspace-Mitglieder, die nicht am Feedback arbeiten, und kostet nichts.
6. **`created_by` auf den Melder setzen**, wenn er ein Kolibri-Konto hat (A5) — sonst als Zeile in
   der zweiten Kontexttabelle (B9).

Ein privates Projekt im bestehenden Workspace wäre erst dann gleichwertig, wenn die
Attachment-Sichtbarkeit repariert ist — das ist der erste Punkt in der Liste unten.

---

## curl: der komplette Happy Path

Alle Aufrufe unten sind so **gemessen** worden, gegen eine geseedete Instanz. Ausgaben gekürzt,
sonst unverändert.

```bash
URL=https://kolibri.example.com
TOKEN=kol_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 0. Einmalig: Workspace-UUID und Projekt-UUID ermitteln

```bash
curl -s "$URL/api/session" -H "authorization: Bearer $TOKEN"
# → {"user":{…},"workspaces":[{"id":"d71146ab-2112-43c2-a1b4-9f9378250ff2",
#                              "name":"Kolibri","slug":"kolibri","role":"owner"}], …}

WS=d71146ab-2112-43c2-a1b4-9f9378250ff2

curl -s "$URL/api/workspaces/$WS/projects" -H "authorization: Bearer $TOKEN"
# → [{"id":"515f51d0-f29b-4a6b-aebd-0473a32d13d6","key":"FB","name":"Feedback", …}]

PROJECT=515f51d0-f29b-4a6b-aebd-0473a32d13d6
```

Beides sind UUIDs. Weder der Slug `kolibri` noch der Key `FB` funktionieren (A2, A3).
Nebenbei nützlich, ohne Token: `curl -s "$URL/api/config"` nennt `maxUploadBytes` (C14).

### 1. Task anlegen — `id` ist SetAsides eigene Report-UUID

```bash
REPORT=9f1c2e40-7b3a-4d51-9c88-1a2b3c4d5e6f

curl -s -X POST "$URL/api/workspaces/$WS/tasks" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d @- <<JSON
{
  "id": "$REPORT",
  "project_id": "$PROJECT",
  "title": "Lead lässt sich nicht speichern",
  "priority": "high",
  "description": "Ein Lead ließ sich nicht speichern.\n\n\`\`\`text\nHier steht der unveränderte Freitext des Melders.\n\`\`\`\n\n| Feld | Wert |\n| --- | --- |\n| URL | /leads/42 |\n| Route | app/leads/[id] |\n| Build | 2026.09.03-a1b2c3 |\n\n| Gemeldet | Wert |\n| --- | --- |\n| Browser | Chrome 141 |\n| Viewport | 1280x720 |\n| Melder | maria@kunde.example |\n"
}
JSON
```

```json
{"id":"9f1c2e40-7b3a-4d51-9c88-1a2b3c4d5e6f","identifier":"FB-2",
 "state_id":"d44e7ab9-…","project_id":"515f51d0-…","priority":"high", …}
```

Kein `state_id` im Request — der Default-State des Projekts wird gesetzt (A1). `id` und
`identifier` kommen beide zurück (A4). Der Freitext steht im Code-Fence, damit Markdown des
Melders das Layout nicht verändert; escapen muss SetAside ihn nicht (B8).

### 2. Screenshot hochladen — derselbe Call hängt ihn an den Task

```bash
curl -s -X POST "$URL/api/workspaces/$WS/files?task_id=$REPORT" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: image/webp' \
  -H 'x-filename: screenshot.webp' \
  --data-binary @screenshot.webp
```

```json
{"url":"/files/f272ceec…/screenshot.webp","hash":"f272ceec…","name":"screenshot.webp",
 "mime":"image/webp","size":389104,"width":1280,"height":720,
 "attachment":{"id":"c8dcedbd-…","task_id":"9f1c2e40-…","name":"screenshot.webp",
               "mime":"image/webp","size":389104,"url":"/files/f272ceec…/screenshot.webp",
               "width":1280,"height":720,"uploaded_by":"21abbfaf-…", …}}
```

Roher Body, kein multipart, kein base64 (C11). `?task_id=` erzeugt die `attachments`-Zeile — ein
dritter Call ist nicht nötig (C12). `attachment.id` in der Antwort ist der Beleg, dass der Anhang
am Task hängt.

**Damit ist der Screenshot am Task sichtbar. Zwei Calls, fertig.**

### 3. Backlink

```bash
echo "$URL/t/$REPORT"      # → https://kolibri.example.com/t/9f1c2e40-…
```

`/t/{id}` oder `/t/{identifier}`, beides funktioniert; die `id` ist stabiler (F24).

### 4. Optional: vor dem Upload prüfen, ob ein Retry ihn schon abgelegt hat

```bash
curl -s "$URL/api/workspaces/$WS/attachments?task_id=$REPORT" -H "authorization: Bearer $TOKEN"
# → [] vor dem Upload, danach eine Zeile pro Upload
```

Nötig, weil der Upload nicht idempotent ist (C13/G25); der Task-Create ist es.

### 5. Zur Kontrolle: die Datei abrufen

```bash
curl -s -D - -o /dev/null "$URL/files/f272ceec…/screenshot.webp" -H "authorization: Bearer $TOKEN"
```

```
HTTP/1.1 200 OK
content-type: image/webp
content-disposition: inline; filename="screenshot.webp"
cache-control: private, max-age=31536000, immutable
x-content-type-options: nosniff
```

Ohne Token: `401`. Mit dem Token *irgendeines* Workspace-Mitglieds: `200` — auch ohne
Projektmitgliedschaft (C16).

---

## Was ich in Kolibri ändern würde

Nach Wirkung sortiert. Die ersten beiden sind für diesen Use Case belastbar begründet; der Rest ist
Komfort.

### 1. Anhänge durch das Projekt schützen, das sie tragen

**Das ist die einzige Änderung, die eine Sicherheitsaussage betrifft.** Heute beantworten zwei
Pfade dieselbe Frage verschieden: Sync prüft das Projekt des Tasks (`sync.ts:315-318`), REST und
die Dateiroute prüfen nur den Workspace (`entities.ts:616` läuft für `attachment` ins Leere,
`files.ts:42`).

Drei Stellen, und alle drei können dieselbe Funktion benutzen:

- `files.ts:42` — nach dem `memberships`-Treffer zusätzlich das tragende Projekt prüfen. Die
  Verbindung ist da: `attachments.task_id → tasks.project_id`. Ein Blob kann an mehreren Tasks
  hängen, also lautet die Frage „darf diese Person *irgendeinen* der Tasks sehen, an denen diese
  Bytes hängen" — genau die Form, die `files.ts:38-42` für den Workspace schon hat.
- `entities.ts:616` — `projectOf` um einen Zweig für `attachment` und `comment` erweitern, oder
  einen `canSeeAttachment` neben `canSeeBudget`/`canSeeKpi` stellen. Die Filterkette bei
  `entities.ts:615-637` ist genau dafür gebaut, und der Kommentar bei `entities.ts:621-623`
  beschreibt schon den gleichen Fall für Budgets: „neither a budget scoped to two projects nor a
  line hanging off one carries a `project_id` the filter above could have tested."
- `files.ts:75-82` — die Workspace-Dateiliste gibt heute Namen und Hash jeder Datei aus, aus der
  sich die URL bauen lässt. Sie müsste denselben Filter bekommen.

Aufwand: geschätzt eine Funktion plus drei Aufrufstellen und drei Tests. **Schätzung, nicht
gemessen.** Der Nutzen: „privates Projekt" bedeutet danach auch für Anhänge, was es für Tasks schon
bedeutet — und die Empfehlung aus H28 könnte „privates Projekt" statt „eigener Workspace" lauten.

### 2. Token-Scoping wirklich durchsetzen

Die Spalte `api_tokens.workspace_id` existiert, wird gefüllt und beim Authentifizieren nicht
gelesen (`auth.ts:140-145`). Sie in die `SELECT`-Liste aufzunehmen und `build` die `memberships`
auf diesen einen Workspace beschneiden zu lassen, wäre **eine Zeile plus ein Filter** — und würde
aus einer Voreinstellung eine Grenze machen.

Das ist eine Verhaltensänderung, keine Ergänzung: bestehende gebundene Tokens würden enger. Der
saubere Weg ist deshalb ein zweites Feld — etwa `confined INTEGER NOT NULL DEFAULT 0` — damit
„Voreinstellung" und „Grenze" zwei Dinge bleiben und alte Tokens weiterlaufen. Die Doku sagt heute
ehrlich, dass es keine Grenze ist (`tokens.ts:29-36`, `de.ts:1996`); die Ehrlichkeit ersetzt aber
nicht die Sache, wenn ein Integrator genau danach fragt.

Verwandt und billiger: `POST /api/tokens` verlangt nur `requireAuth` (`routes/auth.ts:500`), sodass
ein `read`-Token sich ein `read,write`-Token ausstellen kann (**gemessen**). Ein `requireWrite`
statt `requireAuth` — eine Zeile — würde `read` zu dem machen, was `openapi.json` behauptet.
Und ein Token sollte kein Token minten dürfen, das mehr kann als es selbst.

### 3. Constraint-Verletzungen als 400 beantworten, nicht als 500

Eine fehlende `NOT NULL`-Spalte fällt heute in den generischen `catch` (`index.ts:253-254`) und
kommt als `500 internal_error` zurück (**gemessen** für `attachment` ohne `url`). Für jeden Client
mit Retry-Logik ist das die teuerste Fehlklassifikation, die es gibt: ein permanenter Fehler
verkleidet als transienter, fünfmal wiederholt.

`ERR_SQLITE_ERROR` mit `errcode 1299` (`SQLITE_CONSTRAINT_NOTNULL`) in `index.ts` oder in
`writeEntity` abzufangen und als `badRequest` weiterzureichen, wäre eine kleine Ergänzung an
einer Stelle. Der Slug (`bad_request`) und die Form (`{error, message}`) stünden schon.

### 4. Ein Upload, der einen Task mitbringt — oder ein idempotenter Upload

Der Task-Create ist bereits idempotent (G25), der Upload nicht: derselbe Screenshot zweimal
hochgeladen ergibt zwei `attachments`-Zeilen auf einem Blob (**gemessen**). Zwei Wege, beide klein:

- **Idempotenter Upload:** in `storeFile` (`uploads.ts:82`) vor dem `writeEntity` prüfen, ob für
  dieses `(workspace_id, task_id, hash)` schon eine lebende Zeile existiert, und sie dann
  zurückgeben statt eine zweite zu schreiben. Das ist genau die Denkfigur, die `uploads.ts:55-66`
  für den Blob schon anwendet — „zwei Fragen, und sie waren einmal eine" — nur eine Ebene höher.
  Der `hash` steht dafür allerdings nicht in `attachments` (`schema.sql:881-901` hat `checksum`,
  ungenutzt); über `url` ginge es auch, sauberer wäre `checksum` zu füllen.
- **Ein-Call-Create:** `POST /tasks` nimmt `attachments: [{name, mime, content_base64}]` entgegen
  und ruft `storeFile` in derselben `tx()`. Präzedenzfall und Begründung liegen bei
  `tools/tasks.ts:204-217` (`create_tasks_batch`) fertig vor.

Der erste Weg ist der kleinere und löst das eigentliche Problem; der zweite spart einen Round-Trip
und ist bequemer für jeden künftigen Integrator.

### 5. Kleinigkeiten

- **`created_by` wird nicht validiert** (`repo.ts:187-214` listet es nicht in
  `SCOPED_REFERENCES`; **gemessen** mit `"created_by": "nicht-existent"` → `200`). Eine Zeile in
  der Liste — oder eine Prüfung auf Workspace-Mitgliedschaft — würde verhindern, dass ein Task
  jemandem zugeschrieben wird, den es nicht gibt.
- **Unbekannte Query-Filter werden still ignoriert** (`entities.ts:547-549`; **gemessen**:
  `?external_ref=abc` liefert alle Tasks). Ein `400` bei einem Filter, den es nicht gibt, würde
  einen ganzen Fehlerpfad bei Clients abschneiden — heute sieht „filtert nicht" aus wie
  „findet alles".
- **Die Fehler-Slugs haben keine kanonische Liste.** Elf Slugs verteilen sich über die
  Konstruktionsstellen; `openapi.json` beschreibt die Form, nicht die Menge. Ein exportiertes
  `ERROR_CODES` in `http.ts` — mit den fünf Konstruktoren und den direkt konstruierten — wäre die
  eine Quelle, die die Konvention „one number, one source" hier auch für Slugs herstellt.

---

## Was ich nicht belegen kann

- **Verhalten mit `KOLIBRI_STORAGE=s3`.** Alles Gemessene lief auf `disk`. Der Code-Pfad für den
  signierten Redirect ist gelesen (`files.ts:50-57`, `storage.ts:120-127`), die Gültigkeitsdauer
  der signierten URL steht im S3-Adapter und wurde **nicht gemessen** — die Route setzt
  `cache-control: private, max-age=60`, was nicht dasselbe ist wie die Signaturlaufzeit.
- **Ob es einen Sweeper für verwaiste Blobs gibt.** `tools/attachments.ts:169-171` sagt, das sei
  „a separate job, and deliberately not this one"; ob dieser Job existiert, habe ich nicht geprüft.
- **Verhalten hinter einem Reverse-Proxy** (Caddy im mitgelieferten Compose). Body-Limits,
  Timeouts und eventuelles Rate-Limiting des Proxys können 413 und 429 erzeugen, die dieser
  Server nie sendet. Gemessen wurde direkt gegen den Node-Prozess.
- **Der Aufwand für die Änderungsvorschläge** ist geschätzt, nicht gemessen — jede Schätzung ist
  oben als solche markiert.
