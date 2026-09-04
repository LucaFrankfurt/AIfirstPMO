/**
 * The REST surface, written down by the tree rather than by hand.
 *
 * `docs/api.md` is prose, and prose about an API rots the way every number in
 * this repository rots: quietly, while looking confident. Its list of
 * collections said twenty-eight when the server had accepted forty for some
 * time. Nobody lied — somebody added an entity, and the sentence describing the
 * entities was not the thing that changed.
 *
 * So this generates `docs/openapi.json` from the two places that cannot drift
 * from the running server, because the server is built out of them:
 *
 *   - **the registry** (`packages/shared/src/kernel/registry/`) for which
 *     collections exist and what a row of each one holds. `REST_ENTITIES` is
 *     the same map the router resolves a URL segment with, and the field types
 *     come from the interfaces in `types.ts`, read with the TypeScript compiler
 *     rather than a regular expression — so `extends Base` is resolved, an
 *     alias like `MailEncryption` becomes an enum of its three values, and the
 *     docblock above a field becomes its description.
 *   - **the route files** for everything hand-written, scraped from the
 *     `router.<verb>('…')` calls themselves.
 *
 * What it deliberately does **not** do is invent request and response bodies
 * for the hand-written routes. Their shapes live in the handlers, in argument
 * destructuring and early returns, and a generator that guessed at them would
 * produce a document that is wrong in a way nothing checks — which is worse
 * than the prose it replaces. Those paths carry their method, their parameters
 * and the file they are defined in, and stop there. A client generator gets the
 * whole URL surface and real models for every entity; for the rest it gets an
 * honest "look here".
 *
 *   node scripts/openapi.mjs         # check (exit 1 if docs/openapi.json is stale)
 *   node scripts/openapi.mjs --fix   # rewrite it
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'docs/openapi.json';
const TYPES = join(ROOT, 'packages/shared/src/kernel/registry/types.ts');

const { ENTITIES, COLLECTIONS, REST_ENTITIES } =
  await import(join(ROOT, 'packages/shared/src/kernel/registry/entities.ts'));

/* ------------------------------------------------------------- the models */

const program = ts.createProgram([TYPES], {
  strict: true, target: ts.ScriptTarget.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
});
const checker = program.getTypeChecker();
const typesFile = program.getSourceFile(TYPES);

/** The interface declaring each entity, from `EntityMap`. */
function interfaceNames() {
  const map = typesFile.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === 'EntityMap');
  if (!map) throw new Error('types.ts has no EntityMap — the model list cannot be derived');
  const named = {};
  for (const member of map.members) {
    if (ts.isPropertySignature(member) && member.type) named[member.name.getText(typesFile)] = member.type.getText(typesFile);
  }
  return named;
}

/**
 * A TypeScript type as JSON Schema, or `{}` when nothing true can be said.
 *
 * An empty schema is the honest answer for a shape this does not model — it
 * says "anything", which is weaker than the truth and never wrong. Guessing
 * would be the other way round.
 */
function schemaOf(type, depth = 0) {
  const F = ts.TypeFlags;
  if (depth > 6) return {};

  if (type.isUnion()) {
    const parts = type.types;
    const nullable = parts.some((t) => t.flags & (F.Null | F.Undefined));
    const rest = parts.filter((t) => !(t.flags & (F.Null | F.Undefined)));

    // A union of string literals is an enum, which is the useful case: every
    // status, priority and access level in the registry is spelled that way.
    if (rest.length && rest.every((t) => t.isStringLiteral())) {
      const values = rest.map((t) => t.value);
      return nullable ? { type: ['string', 'null'], enum: [...values, null] } : { type: 'string', enum: values };
    }
    if (!rest.length) return { type: 'null' };

    /*
     * Deduplicated, because `boolean` is not one type down here.
     *
     * The checker expands `boolean | null` to `true | false | null`, and each
     * half maps to the same `{ type: 'boolean' }` — which came out as an
     * `anyOf` listing boolean twice. Valid, and nonsense to read. Comparing the
     * rendered schemas catches that and anything else that collapses.
     */
    const seen = new Map();
    for (const member of rest) {
      const schema = schemaOf(member, depth + 1);
      seen.set(JSON.stringify(schema), schema);
    }
    const distinct = [...seen.values()];

    if (distinct.length === 1) {
      const [inner] = distinct;
      if (!nullable || !inner.type) return inner;
      return { ...inner, type: Array.isArray(inner.type) ? inner.type : [inner.type, 'null'] };
    }
    return { anyOf: nullable ? [...distinct, { type: 'null' }] : distinct };
  }

  if (type.flags & F.BooleanLike) return { type: 'boolean' };
  if (type.isStringLiteral()) return { type: 'string', enum: [type.value] };
  if (type.isNumberLiteral()) return { type: 'number', enum: [type.value] };
  if (type.flags & F.StringLike) return { type: 'string' };
  if (type.flags & F.NumberLike) return { type: 'number' };
  if (type.flags & (F.Null | F.Undefined | F.Void)) return { type: 'null' };

  if (checker.isArrayType(type)) {
    return { type: 'array', items: schemaOf(checker.getTypeArguments(type)[0], depth + 1) };
  }
  if (checker.isTupleType(type)) {
    return { type: 'array', prefixItems: checker.getTypeArguments(type).map((t) => schemaOf(t, depth + 1)) };
  }

  if (type.flags & F.Object) {
    // `Record<K, V>` and anything else with a string index signature.
    const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (index) return { type: 'object', additionalProperties: schemaOf(index.type, depth + 1) };
    const props = checker.getPropertiesOfType(type);
    if (!props.length) return {};
    const properties = {};
    for (const prop of props) properties[prop.name] = described(prop, schemaOf(typeOfProperty(prop), depth + 1));
    return { type: 'object', properties };
  }
  return {};
}

const typeOfProperty = (prop) =>
  checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? prop.declarations?.[0] ?? typesFile);

/** The docblock above a field, if it has one — the field's own sentence. */
function described(prop, schema) {
  const doc = ts.displayPartsToString(prop.getDocumentationComment(checker)).replace(/\s+/g, ' ').trim();
  return doc ? { ...schema, description: doc } : schema;
}

function models() {
  const named = interfaceNames();
  const out = {};
  for (const entity of Object.keys(REST_ENTITIES).map((segment) => REST_ENTITIES[segment]).sort()) {
    const name = named[entity];
    const declaration = typesFile.statements.find((s) => ts.isInterfaceDeclaration(s) && s.name.text === name);
    if (!declaration) throw new Error(`no interface for entity ${entity} (EntityMap says ${name})`);

    const def = ENTITIES[entity];
    const secret = new Set(def.secret ?? []);
    const serverOnly = new Set([...(def.serverOnly ?? []), 'id', 'created_at', 'updated_at', 'deleted_at', 'seq']);
    const properties = {};
    for (const prop of checker.getPropertiesOfType(checker.getTypeAtLocation(declaration.name))) {
      // A secret never leaves the server, so it is not part of the API at all —
      // describing it would be describing a field no caller can ever see.
      if (secret.has(prop.name)) continue;
      const schema = described(prop, schemaOf(typeOfProperty(prop)));
      properties[prop.name] = serverOnly.has(prop.name) ? { ...schema, readOnly: true } : schema;
    }
    out[name] = {
      type: 'object',
      description: `A row of \`${COLLECTIONS[entity]}\` (table \`${def.table}\`).`,
      properties: Object.fromEntries(Object.keys(properties).sort().map((k) => [k, properties[k]])),
    };
  }
  return out;
}

/* -------------------------------------------------------------- the paths */

/** Every `.ts` under a directory, in a stable order. */
function walk(dir, found = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (name.endsWith('.ts')) found.push(full);
  }
  return found;
}

/**
 * The hand-written routes, read off the registrations themselves.
 *
 * Parsed rather than matched. The first version used a regular expression and
 * promptly found a route inside a *comment* — a docblock in `http.ts` that
 * quotes `router.get('…')` while explaining what the router does. A comment is
 * not a route, and no amount of tightening the pattern makes a regular
 * expression know the difference. TypeScript is already loaded here for the
 * models, so the same parser reads the calls.
 *
 * A path built at runtime would silently not appear, so one is refused rather
 * than skipped: this has to be all of them or it is worth nothing.
 */
function scrapedPaths() {
  const VERBS = new Set(['get', 'post', 'patch', 'put', 'delete']);
  const found = [];

  for (const file of walk(join(ROOT, 'packages/server/src'))) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('router.')) continue;
    const where = relative(ROOT, file);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);

    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const on = node.expression.expression;
        const onRouter = ts.isIdentifier(on) && on.text === 'router';
        if (onRouter && VERBS.has(method)) {
          const [first] = node.arguments;
          if (!first || !ts.isStringLiteral(first)) {
            const shown = first ? first.getText(source) : '(nothing)';
            throw new Error(`${where}: router.${method}() with a path this cannot read: ${shown}`);
          }
          found.push({ method, path: first.text, where });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** `/api/workspaces/:ws/:collection` -> `/api/workspaces/{ws}/{collection}`. */
/**
 * `/api/workspaces/:ws/:collection` -> `/api/workspaces/{ws}/{collection}`.
 *
 * A trailing `*` becomes `{path}`, because OpenAPI has no wildcard and a
 * trailing parameter is how the same thing is spelled. There is one such route
 * — `/files/:hash/*`, where the rest of the URL is the name the browser should
 * save the file under — and leaving it as `*` would have put a path in the
 * document that no client can call. `openapi.test.ts` applies the same rule
 * from the other side, so the two spellings cannot quietly disagree.
 */
const braced = (path) => path.replace(/:(\w+)/g, '{$1}').replace(/\/\*$/, '/{path}');

/**
 * A name a client generator can make a method out of, derived from the route.
 *
 * `POST /api/workspaces/:ws/mailboxes/:id/password` -> `postWorkspacesMailboxesPassword`.
 *
 * Interior parameters are dropped and a *trailing* one becomes `By<Name>`,
 * which is not decoration: without it `/pages/:id/versions` and
 * `/pages/:id/versions/:versionId` are the same name, and so are two more pairs
 * in this tree. `checkIds` below refuses a collision outright rather than
 * suffixing it with a number, because a generated client whose method names
 * shift when a route is added is worse than a build that stops.
 */
const camel = (part) => part
  .replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
  .replace(/^./, (c) => c.toUpperCase());

function operationId(method, path) {
  const parts = path.replace(/^\/api\//, '/').replace(/\/\*$/, '/:path').split('/').filter(Boolean);
  const trailing = parts.at(-1)?.startsWith(':') ? parts.at(-1).slice(1) : null;
  const named = parts.filter((part) => !part.startsWith(':')).map(camel).join('');
  return method + named + (trailing ? `By${camel(trailing)}` : '');
}

/** Two routes cannot share a name, and finding out later is finding out badly. */
function checkIds(paths) {
  const seen = new Map();
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const id = operation.operationId;
      if (!id) continue;
      const first = seen.get(id);
      if (first) throw new Error(`two routes want the operationId ${id}: ${first} and ${method.toUpperCase()} ${path}`);
      seen.set(id, `${method.toUpperCase()} ${path}`);
    }
  }
}

const pathParams = (path) => [
  ...[...path.matchAll(/:(\w+)/g)].map(([, name]) => ({
    name, in: 'path', required: true, schema: { type: 'string' },
  })),
  ...(path.endsWith('/*')
    ? [{ name: 'path', in: 'path', required: true, schema: { type: 'string' }, description: 'The rest of the URL — the name the file is saved under.' }]
    : []),
];

/* ----------------------------------------------------------- the document */

const LIST_QUERY = [
  { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000 }, description: 'At most 1000.' },
  { name: 'offset', in: 'query', schema: { type: 'integer' } },
  { name: 'order_by', in: 'query', schema: { type: 'string' }, description: 'Any field of the row.' },
  { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
  { name: 'include_deleted', in: 'query', schema: { type: 'string', enum: ['1'] } },
];

const json = (schema) => ({ content: { 'application/json': { schema } } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

/*
 * The failures worth writing down, and only the ones that are true of every
 * route of that shape.
 *
 * 401 belongs on all of them: there is no anonymous route in this surface — a
 * share link is served from `/s/…`, not from here. 403 goes on anything that
 * writes, because a `read` token is refused on every write and a private
 * project is refused to a member who is not in it. 404 goes on the by-id
 * routes, where "not visible to you" and "not there" deliberately answer the
 * same, so that a stranger cannot map the workspace by watching status codes.
 */
const fails = (...codes) => Object.fromEntries(codes.map((code) => [code, {
  description: {
    401: 'No credentials, or credentials this server does not accept.',
    403: 'Authenticated, and not allowed to do this.',
    404: 'No such row — or one this caller may not see, which answers the same on purpose.',
    400: 'The body was refused — a rule in the registry, or one the entity keeps for itself.',
  }[code],
  ...json(ref('Error')),
}]));

const ERROR_SCHEMA = {
  type: 'object',
  description: 'Every failure answers in this shape, with a matching HTTP status.',
  properties: {
    error: { type: 'string', description: 'A stable slug — `forbidden`, `not_found`, `invalid_redirect_uri`.' },
    message: { type: 'string', description: 'A sentence for a person, which may name the thing that was wrong.' },
  },
  required: ['error'],
};

function document() {
  const schemas = models();
  const named = interfaceNames();
  const paths = {};

  for (const segment of Object.keys(REST_ENTITIES).sort()) {
    const entity = REST_ENTITIES[segment];
    const model = named[entity];
    const one = `${entity}`;

    paths[`/api/workspaces/{ws}/${segment}`] = {
      get: {
        operationId: `list${model}`,
        summary: `List ${segment}`,
        description: 'Filterable by any field of the row: `?project_id=…&priority=urgent`, and `?field=null` for rows that have none.',
        tags: [segment],
        parameters: [
          { name: 'ws', in: 'path', required: true, schema: { type: 'string' } },
          ...LIST_QUERY,
        ],
        responses: {
          200: { description: `The ${segment} this caller may see.`, ...json({ type: 'object', properties: { [segment]: { type: 'array', items: ref(model) } } }) },
          ...fails(401, 403),
        },
      },
      post: {
        operationId: `create${model}`,
        summary: `Create a ${one}`,
        tags: [segment],
        parameters: [{ name: 'ws', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: json(ref(model)),
        responses: { 200: { description: 'The row as it was stored.', ...json(ref(model)) }, ...fails(400, 401, 403) },
      },
    };

    paths[`/api/${segment}/{id}`] = {
      get: {
        operationId: `get${model}`,
        summary: `Read one ${one}`,
        tags: [segment],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The row.', ...json(ref(model)) }, ...fails(401, 403, 404) },
      },
      patch: {
        operationId: `update${model}`,
        summary: `Change a ${one}`,
        description: 'Partial: only the fields present are written.',
        tags: [segment],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: json(ref(model)),
        responses: { 200: { description: 'The row as it now stands.', ...json(ref(model)) }, ...fails(400, 401, 403, 404) },
      },
      delete: {
        operationId: `delete${model}`,
        summary: `Delete a ${one}`,
        description: 'Soft: the row keeps its place in the sync log and comes back as deleted.',
        tags: [segment],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted.' }, ...fails(401, 403, 404) },
      },
    };
  }

  /*
   * Everything hand-written, and it **wins** where it collides.
   *
   * The generic entity routes are registered with `:collection` in them, so
   * they are skipped here — they are already spelled out above, once per
   * collection. What is not obvious is that spelling them out can collide with
   * a real handler: `GET /api/workspaces/:ws/mailboxes` is written by hand, in
   * the mail module, and returns rows with their credential state attached
   * rather than plain registry rows.
   *
   * The router matches in registration order and that route is registered
   * first, so the hand-written one is what answers — and the first version of
   * this generator skipped it as a duplicate and left the document describing
   * the route that never runs. Overwriting is what the server does; the
   * document says the same. `openapi.test.ts` holds the order to it.
   */
  const generic = /^\/api\/(workspaces\/:ws\/)?:collection/;
  for (const { method, path, where } of scrapedPaths()) {
    if (generic.test(path)) continue;
    const key = braced(path);
    paths[key] ??= {};
    paths[key][method] = {
      operationId: operationId(method, path),
      summary: `${method.toUpperCase()} ${path}`,
      description: `Defined in \`${where}\`. Its request and response shapes are not derivable from the registry, so they are not described here — read the handler.`,
      tags: ['hand-written'],
      parameters: pathParams(path),
      responses: { 200: { description: 'See the handler.' }, ...fails(401) },
    };
  }

  checkIds(paths);

  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kolibri',
      version,
      description: [
        'Generated by `scripts/openapi.mjs` from the entity registry and the route files. Do not edit by hand —',
        '`npm run openapi` rewrites it, and `npm run check:openapi` fails if it has drifted from the tree.',
        '',
        'Every entity in the registry has the same five routes and a real schema below. The hand-written routes',
        'are listed with their method and parameters only: their bodies live in the handlers, and a guess would be',
        'a claim nothing checks.',
      ].join('\n'),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: '{instance}', variables: { instance: { default: 'https://kolibri.example.com' } } }],
    security: [{ token: [] }, { session: [] }],
    components: {
      securitySchemes: {
        token: { type: 'http', scheme: 'bearer', description: 'An API token from **Settings → API & MCP**, or `POST /api/tokens`. A `read` token is refused on every write.' },
        session: { type: 'apiKey', in: 'cookie', name: 'kolibri_session', description: 'What the web app uses, from `POST /api/auth/login`.' },
      },
      schemas: Object.fromEntries(Object.entries({ ...schemas, Error: ERROR_SCHEMA }).sort()),
    },
    paths: Object.fromEntries(Object.keys(paths).sort().map((k) => [k, paths[k]])),
  };
}

/* ------------------------------------------------------------- the check */

const rendered = `${JSON.stringify(document(), null, 2)}\n`;
const target = join(ROOT, OUT);
const before = (() => { try { return readFileSync(target, 'utf8'); } catch { return null; } })();

const counts = () => {
  const spec = JSON.parse(rendered);
  const operations = Object.values(spec.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  return `${Object.keys(spec.paths).length} paths, ${operations} operations, ${Object.keys(spec.components.schemas).length} models`;
};

if (process.argv.includes('--fix')) {
  if (before === rendered) console.log(`${OUT}: already current — ${counts()}.`);
  else { writeFileSync(target, rendered); console.log(`${OUT}: rewritten — ${counts()}.`); }
  process.exit(0);
}

if (before === null) {
  console.error(`${OUT} does not exist. Run \`npm run openapi\`.`);
  process.exit(1);
}
if (before !== rendered) {
  console.error(`${OUT} no longer matches the tree. Run \`npm run openapi\`.`);
  process.exit(1);
}
console.log(`${OUT}: matches the tree — ${counts()}.`);
