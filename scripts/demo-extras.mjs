/**
 * The parts of a lived-in workspace that `npm run seed` does not create.
 *
 * The seed fills the board, the cycle, the pages and the backlog — everything
 * that has a project to hang off. Chat has none: a conversation belongs to the
 * workspace or to nobody, so seeding one would mean the seed inventing who
 * said what to whom. That is right for a fixture and wrong for a *demo*, where
 * a visitor who clicks Chat and finds "no conversations yet" has learned that
 * the feature is a claim rather than a screen.
 *
 * So this is separate, and deliberately not part of `demo.ts`: it runs over
 * the public REST API against a running instance, as an ordinary signed-in
 * person, and every row it writes is one somebody could have written by hand.
 * Nothing here is a special case in the server.
 *
 *   node scripts/demo-extras.mjs
 *   KOLIBRI_URL=https://app.demo.kolibri.day node scripts/demo-extras.mjs
 *
 * It is idempotent by name: a channel that already exists is reused and left
 * alone, so the demo's reset can run it every night without stacking up
 * eleven copies of the same conversation.
 */
const base = process.env.KOLIBRI_URL ?? 'http://localhost:4400';
const email = process.env.KOLIBRI_DEMO_EMAIL ?? 'ada@kolibri.dev';
const password = process.env.KOLIBRI_DEMO_PASSWORD ?? 'kolibri-demo';

/* One cookie jar, kept by hand — there is no browser here to keep it. */
let cookie = '';

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

const session = await call('POST', '/api/auth/login', { email, password });
const workspace = session.workspaces?.[0];
if (!workspace) throw new Error('that account is not in a workspace');
const me = session.user.id;

/* `id` on a member row is the *membership*, not the person. A direct
   conversation's id is built from user ids, and using the wrong one produces a
   room whose own creator is not in it — which the server correctly refuses. */
const members = await call('GET', `/api/workspaces/${workspace.id}/members`);
const userIdOf = (name) => members.find((m) => (m.name ?? '').startsWith(name))?.user_id;
const grace = userIdOf('Grace');

/* ------------------------------------------------------------- a channel */

const channels = await call('GET', `/api/workspaces/${workspace.id}/channels`);
const existing = channels.find((c) => c.name === 'general');

const channel =
  existing ??
  (await call('POST', `/api/workspaces/${workspace.id}/channels`, {
    name: 'general',
    kind: 'channel',
    topic: 'Everything that is not a task yet',
  }));

if (existing) {
  console.log('#general already exists — leaving it alone');
} else {
  /* Written as four people rather than one, because a channel where one
     account is talking to itself demonstrates the opposite of a team tool.
     Each line is posted by that person's own session: `author_id` is the
     session and never the payload, which is exactly the rule being relied on
     here rather than worked around. */
  const script = [
    [email, 'Morning. WEB-1 is in review — the pricing page redesign. Whoever has twenty minutes.'],
    ['grace@kolibri.dev', 'Taking it. Is WEB-4 blocked on it, or can that go in parallel?'],
    [email, 'Parallel. The only real dependency is WEB-8 waiting on WEB-6.'],
    ['alan@kolibri.dev', 'I moved the cookie banner work into next cycle — it grew a legal review.'],
    ['margaret@kolibri.dev', 'Wrote up what we decided about the consent flow: it is on the Team handbook page.'],
  ];

  const ours = cookie;
  for (const [who, body] of script) {
    if (who !== email) {
      cookie = '';
      await call('POST', '/api/auth/login', { email: who, password });
    } else {
      cookie = ours;
    }
    await call('POST', `/api/workspaces/${workspace.id}/messages`, {
      channel_id: channel.id,
      body,
    });
  }
  cookie = '';
  await call('POST', '/api/auth/login', { email, password });
  console.log(`#general seeded with ${script.length} messages`);
}

/* ------------------------------------------------- one direct conversation */

if (grace) {
  /* The id is derived rather than invented — `dm.<a>.<b>` with the two user
     ids sorted — which is what lets two devices open the same conversation
     while both are offline. Creating one and finding one are the same call. */
  const id = `dm.${[me, grace].sort().join('.')}`;
  await call('POST', `/api/workspaces/${workspace.id}/channels`, { id, kind: 'direct' });

  const already = await call('GET', `/api/workspaces/${workspace.id}/messages?channel_id=${id}`);
  if (Array.isArray(already) && already.length) {
    console.log('the direct conversation already has messages — leaving it alone');
  } else {
    await call('POST', `/api/workspaces/${workspace.id}/messages`, {
      channel_id: id,
      body: 'Did the German localisation ticket ever get an estimate? WEB-9.',
    });
    cookie = '';
    await call('POST', '/api/auth/login', { email: 'grace@kolibri.dev', password });
    await call('POST', `/api/workspaces/${workspace.id}/messages`, {
      channel_id: id,
      body: 'Thirteen points, and I think that is optimistic. Adding a note to the task.',
    });
    cookie = '';
    await call('POST', '/api/auth/login', { email, password });
    console.log('direct conversation with Grace seeded');
  }
}

console.log('done');
