/**
 * Demo data.
 *
 * Creates a workspace with two teams, three projects, a running cycle, a
 * backlog with realistic spread, wiki pages and comments — enough to see every
 * view populated on first launch. Run from the CLI with `npm run seed`, or
 * automatically on an empty database with KOLIBRI_SEED_DEMO=true.
 */
import { makeAnchor, orderKey, orderKeys } from '@kolibri/shared';
import { all, get, run, type Row } from '../../kernel/platform/db/index.ts';
import { hashPassword } from '../../kernel/identity/auth.ts';
import { addMember, createProject, createWorkspace, serverClock } from '../../kernel/write-path/bootstrap.ts';
import { uid } from '../../kernel/platform/ids.ts';
import { writeEntity } from '../../kernel/write-path/repo.ts';

const hlc = () => serverClock.now();
const day = 86_400_000;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);

function user(email: string, name: string, password = 'kolibri-demo'): string {
  const existing = get<Row>(`SELECT id FROM users WHERE email = ?`, email);
  if (existing) return existing.id;
  const id = uid();
  const now = Date.now();
  run(
    `INSERT INTO users (id, email, name, password_hash, created_at, updated_at, seq, clocks) VALUES (?, ?, ?, ?, ?, ?, 0, '{}')`,
    id, email, name, hashPassword(password), now, now,
  );
  writeEntity('user', id, { name, email }, { workspaceId: '', actorId: id, hlc: hlc(), system: true, silent: true });
  return id;
}

const PEOPLE = [
  ['ada@kolibri.dev', 'Ada Lovelace'],
  ['grace@kolibri.dev', 'Grace Hopper'],
  ['alan@kolibri.dev', 'Alan Turing'],
  ['margaret@kolibri.dev', 'Margaret Hamilton'],
];

const BACKLOG: Record<string, [string, string, string, number | null][]> = {
  WEB: [
    ['Redesign the pricing page', 'started', 'high', 5],
    ['Ship dark mode across the marketing site', 'unstarted', 'medium', 3],
    ['Cut largest-contentful-paint below 1.5s', 'started', 'urgent', 8],
    ['Rewrite the onboarding copy', 'backlog', 'low', 2],
    ['Replace the cookie banner with a first-party consent flow', 'backlog', 'medium', 3],
    ['Fix layout shift on the changelog', 'completed', 'medium', 1],
    ['Add customer logos to the landing page', 'unstarted', 'low', 1],
    ['Localise the docs into German', 'backlog', 'medium', 13],
  ],
  API: [
    ['Rate-limit the public API per token', 'started', 'urgent', 5],
    ['Publish an OpenAPI description', 'unstarted', 'high', 3],
    ['Move attachments to content-addressed storage', 'completed', 'high', 8],
    ['Add cursor pagination to /tasks', 'unstarted', 'medium', 3],
    ['Webhook delivery with retries', 'backlog', 'medium', 8],
    ['Audit log for permission changes', 'backlog', 'high', 5],
  ],
  MOB: [
    ['Offline queue for task edits', 'started', 'urgent', 8],
    ['Push notifications for mentions', 'unstarted', 'high', 5],
    ['Swipe to change state on the board', 'unstarted', 'medium', 3],
    ['Shrink the app bundle below 400kb', 'backlog', 'low', 3],
  ],
};

export function seedDemoData(): boolean {
  // Guard on the demo's own marker, not on "is the database empty": a
  // provisioned owner account may already have created a workspace.
  if (get(`SELECT id FROM users WHERE email = 'ada@kolibri.dev'`)) return false;

  const ids = PEOPLE.map(([email, name]) => user(email, name));
  const [ada, grace, alan, margaret] = ids;
  run(`UPDATE users SET is_admin = 1 WHERE id = ?`, ada);

  const workspace = createWorkspace('Kolibri', ada, 'kolibri');
  const ws = workspace.id;
  for (const id of ids.slice(1)) addMember(ws, id, 'member');
  addMember(ws, grace, 'admin');

  const teams = [
    { name: 'Product', key: 'PRD', icon: '🧭', color: '#6366f1', members: [ada, margaret] },
    { name: 'Platform', key: 'PLT', icon: '🛠️', color: '#0ea5e9', members: [grace, alan] },
  ].map((team) => {
    const teamId = uid();
    writeEntity('team', teamId, { workspace_id: ws, name: team.name, key: team.key, icon: team.icon, color: team.color },
      { workspaceId: ws, actorId: ada, hlc: hlc(), system: true });
    for (const userId of team.members) {
      writeEntity('teamMember', uid(), { workspace_id: ws, team_id: teamId, user_id: userId, role: 'member' },
        { workspaceId: ws, actorId: ada, hlc: hlc(), system: true });
    }
    return { ...team, id: teamId };
  });

  // Dates that overlap and disagree, so the roadmap has something to show:
  // one nearly finished, one just starting, one already past its target.
  const projects = [
    { name: 'Website', key: 'WEB', icon: '🌐', color: '#6366f1', team: teams[0].id, lead: ada, from: -60, to: 20 },
    { name: 'Public API', key: 'API', icon: '🔌', color: '#0ea5e9', team: teams[1].id, lead: grace, from: -20, to: 70 },
    { name: 'Mobile app', key: 'MOB', icon: '📱', color: '#f59e0b', team: teams[0].id, lead: margaret, from: -90, to: -5 },
  ].map((project) => {
    const row = createProject(ws, project.lead, {
      name: project.name, key: project.key, icon: project.icon, color: project.color, teamId: project.team,
      description: `Everything we ship for ${project.name.toLowerCase()}.`,
    });
    writeEntity('project', row.id, { start_date: isoDate(project.from), target_date: isoDate(project.to) },
      { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });
    for (const userId of ids) {
      if (userId === project.lead) continue;
      writeEntity('projectMember', uid(), { workspace_id: ws, project_id: row.id, user_id: userId, role: 'member' },
        { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });
    }
    return { ...project, id: row.id };
  });

  for (const project of projects) {
    const states = all<Row>(`SELECT * FROM states WHERE project_id = ? ORDER BY sort_order`, project.id);
    const stateByGroup = (group: string) => states.find((s) => s.group_key === group) ?? states[0];
    const labels = all<Row>(`SELECT * FROM labels WHERE project_id = ?`, project.id);

    // One column with an agreed limit, so a fresh demo shows what one looks
    // like — including a column that is over it, which is the interesting case.
    const started = states.find((state) => state.group_key === 'started');
    if (started) {
      writeEntity('state', String(started.id), { wip_limit: 2 },
        { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });
    }

    const cycleId = uid();
    writeEntity('cycle', cycleId, {
      workspace_id: ws, project_id: project.id, name: `Cycle ${new Date().getUTCFullYear()}-${Math.ceil((new Date().getUTCMonth() + 1) / 1)}`,
      description: 'Two week cycle', start_date: isoDate(-4), end_date: isoDate(10),
    }, { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });

    writeEntity('cycle', uid(), {
      workspace_id: ws, project_id: project.id, name: 'Next cycle',
      start_date: isoDate(11), end_date: isoDate(25),
    }, { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });

    const moduleId = uid();
    writeEntity('module', moduleId, {
      workspace_id: ws, project_id: project.id, name: `${project.name} v2`,
      description: 'The next major milestone', lead_id: project.lead, target_date: isoDate(45), status: 'in_progress',
    }, { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });

    const items = BACKLOG[project.key] ?? [];
    const orders = orderKeys(items.length);
    let blockedBy: string | null = null;
    items.forEach(([title, group, priority, estimate], index) => {
      const assignee = ids[(index + projects.indexOf(project)) % ids.length];
      const inCycle = group === 'started' || (group === 'unstarted' && index % 2 === 0);
      const { row } = writeEntity('task', uid(), {
        workspace_id: ws,
        project_id: project.id,
        title,
        description: `## Context\n\n${title} — pulled in from the roadmap.\n\n## Acceptance\n\n- [ ] Implementation\n- [ ] Tests\n- [ ] Documentation\n`,
        state_id: stateByGroup(group).id,
        priority,
        estimate,
        assignees: [assignee],
        labels: index % 3 === 0 && labels.length ? [labels[index % labels.length].id] : [],
        cycle_id: inCycle ? cycleId : null,
        module_id: index % 3 === 0 ? moduleId : null,
        // Dated work in pairs — a start and a due date — so the timeline has
        // bars to draw rather than a row of single days.
        start_date: index % 2 === 0 ? isoDate(index * 2 - 6) : null,
        due_date: index % 2 === 0 ? isoDate(index * 2 + 2) : isoDate(index - 2),
        sort_order: orders[index],
        created_by: project.lead,
      }, { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });

      // A little time against the work in flight, so the totals and the
      // timesheet are not a row of zeros on a fresh demo.
      if (group === 'started' || group === 'completed') {
        writeEntity('timeEntry', uid(), {
          workspace_id: ws, project_id: project.id, task_id: row.id, user_id: assignee,
          minutes: 45 + ((index * 35) % 180), spent_on: isoDate(-(index % 7) - 1),
          note: null, billable: 1,
        }, { workspaceId: ws, actorId: assignee, hlc: hlc(), system: true });
      }

      // A chain of two, so the chart has a dependency to draw and to enforce.
      if (index === 2) blockedBy = row.id;
      if (index === 4 && blockedBy) {
        writeEntity('relation', uid(), {
          workspace_id: ws, task_id: blockedBy, related_task_id: row.id, kind: 'blocks',
        }, { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });
      }

      if (index === 0) {
        writeEntity('comment', uid(), {
          workspace_id: ws, task_id: row.id, author_id: grace,
          body: 'Starting on this today — I will post a preview link once the first pass is deployed.',
        }, { workspaceId: ws, actorId: grace, hlc: hlc(), system: true });
        writeEntity('task', uid(), {
          workspace_id: ws, project_id: project.id, title: `${title} — QA pass`,
          state_id: stateByGroup('backlog').id, parent_id: row.id, priority: 'low',
          assignees: [alan], sort_order: orderKey(null, null),
        }, { workspaceId: ws, actorId: project.lead, hlc: hlc(), system: true });
      }
    });
  }

  /*
   * The demo's pages are not all drafts, because a wiki where everything says
   * the same thing teaches nothing about the word. The handbook and the
   * supplier's document are settled, the incident runbook is being read by
   * somebody, and the API principles page is still a draft — which is also the
   * one the default would have given it anyway, so one page here proves the
   * default and three prove the ladder.
   */
  const rung = (kind: string): string | null =>
    (get<Row>(`SELECT id FROM page_statuses WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL`, ws, kind)?.id as string) ?? null;
  const settled = rung('final');
  const reading = rung('review');

  /*
   * A canvas, so the demo shows one and so every screen check that walks the
   * seeded instance walks one too — at every width, in both themes. Written
   * before the handbook on purpose: the pages index shows the six most
   * recently edited, the smoke walkthrough opens the handbook from there, and
   * a newer page here is one fewer slot for it.
   */
  const canvas = uid();
  const asAda = { workspaceId: ws, actorId: ada, hlc: hlc(), system: true };
  writeEntity('page', canvas, {
    workspace_id: ws, title: 'Sales pipeline', icon: '🎨', format: 'canvas', access: 'workspace', created_by: ada,
    content: '',
  }, asAda);
  const pipeline = uid();
  const PIPELINE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #14161c; background: #ffffff; line-height: 1.5; }
    td, th { padding: 9px 12px; border-bottom: 1px solid #e5e6eb; text-align: left; }
  </style>
</head>
<body>
  <main style="max-width: 1180px; margin: 0 auto; padding: 32px; display: flex; flex-direction: column; gap: 20px">
    <h1 style="margin: 0; font-size: 28px">Pipeline this quarter</h1>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px">
      <div style="padding: 18px; border: 1px solid #e5e6eb; border-radius: 12px"><p style="margin: 0; font-size: 12px; color: #646872">Open deals</p><p style="margin: 4px 0 0; font-size: 28px; font-weight: 700" id="count">0</p></div>
      <div style="padding: 18px; border: 1px solid #e5e6eb; border-radius: 12px"><p style="margin: 0; font-size: 12px; color: #646872">Pipeline value</p><p style="margin: 4px 0 0; font-size: 28px; font-weight: 700" id="total">0</p></div>
      <div style="padding: 18px; border: 1px solid #e5e6eb; border-radius: 12px; background: #eeeefc"><p style="margin: 0; font-size: 12px; color: #2e2e8f">Target</p><p style="margin: 4px 0 0; font-size: 28px; font-weight: 700; color: #2e2e8f">€250k</p></div>
    </div>
    <table style="width: 100%; border-collapse: collapse">
      <tr><th>Company</th><th>Stage</th><th>Value (€k)</th></tr>
      <tr><td>Acme</td><td>Demo</td><td class="value">80</td></tr>
      <tr><td>Globex</td><td>Proposal</td><td class="value">45</td></tr>
      <tr><td>Initech</td><td>First call</td><td class="value">30</td></tr>
    </table>
  </main>
  <script>
    // The tiles add themselves up from the table, so editing a row is enough.
    const values = [...document.querySelectorAll('.value')].map((cell) => Number(cell.textContent) || 0);
    document.getElementById('count').textContent = String(values.length);
    document.getElementById('total').textContent = '€' + values.reduce((a, b) => a + b, 0) + 'k';
  </script>
</body>
</html>
`;
  writeEntity('artboard', pipeline, {
    workspace_id: ws, page_id: canvas, kind: 'html', title: 'Pipeline', x: 0, y: 0, w: 1280, h: 720,
    content: PIPELINE, sort_order: orderKey(null, null), created_by: ada,
  }, asAda);
  const script = uid();
  const SCRIPT = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #14161c; background: #ffffff; line-height: 1.55; }</style>
</head>
<body>
  <main style="padding: 40px; display: flex; flex-direction: column; gap: 14px">
    <h1 style="margin: 0; font-size: 26px">Cold call script</h1>
    <p style="margin: 0">Hi, this is Ada from Kolibri. Do you have two minutes?</p>
    <h2 style="margin: 8px 0 0; font-size: 18px">If they say yes</h2>
    <ul style="margin: 0; padding-left: 20px">
      <li>Ask how they plan projects today.</li>
      <li>Listen for the tool they are leaving.</li>
      <li>Offer a 20-minute demo this week.</li>
    </ul>
    <div style="padding: 14px 16px; border-radius: 10px; background: #eeeefc; color: #2e2e8f"><strong>Never</strong> read the price list out on a first call.</div>
  </main>
</body>
</html>
`;
  writeEntity('artboard', script, {
    workspace_id: ws, page_id: canvas, kind: 'html', title: 'Cold call script', x: 1360, y: 0, w: 760, h: 720,
    content: SCRIPT, sort_order: orderKey(orderKey(null, null), null), created_by: ada,
  }, asAda);
  writeEntity('artboard', uid(), {
    workspace_id: ws, page_id: canvas, kind: 'note', title: '', color: 'yellow', x: 1360, y: 780, w: 300, h: 160,
    content: 'Grace: confirm the Q3 target with finance before Friday.', sort_order: orderKey(orderKey(orderKey(null, null), null), null),
    created_by: ada,
  }, asAda);
  writeEntity('comment', uid(), {
    workspace_id: ws, page_id: canvas, author_id: grace, body: 'Is Acme still at the demo stage? I heard they signed on Tuesday.',
    anchor: { board: pipeline, x: 60, y: 300 }, reactions: {},
  }, { workspaceId: ws, actorId: grace, hlc: hlc(), system: true });
  const greeting = SCRIPT.indexOf('Hi, this is Ada');
  writeEntity('comment', uid(), {
    workspace_id: ws, page_id: canvas, author_id: alan, body: 'Friendlier opener?', reactions: {},
    anchor: { board: script, x: 40, y: 80, ...makeAnchor(SCRIPT, greeting, greeting + 'Hi, this is Ada'.length) },
    suggestion: 'Hello, Ada here',
  }, { workspaceId: ws, actorId: alan, hlc: hlc(), system: true });

  /*
   * A board on its own, under the canvas: the same kind of board, shown as a
   * page. Taller than its frame on purpose, so the page grows to it — which is
   * the one thing a board page does that a canvas does not — and every screen
   * check walks that too.
   */
  const review = uid();
  writeEntity('page', review, {
    workspace_id: ws, parent_id: canvas, title: 'Q3 review one-pager', icon: '🖼️', format: 'board', access: 'workspace',
    created_by: ada, content: '',
  }, asAda);
  const reviewBoard = uid();
  const REVIEW = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #14161c; background: #ffffff; line-height: 1.55; }</style>
</head>
<body>
  <main style="max-width: 980px; margin: 0 auto; padding: 40px 40px 56px; display: flex; flex-direction: column; gap: 22px">
    <p style="margin: 0; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #2e2e8f">Quarterly review · Sales</p>
    <h1 style="margin: 0; font-size: 32px">Q3 in one page</h1>
    <p style="margin: 0; font-size: 17px; color: #3d4048">Pipeline grew, conversion held, and the demo-to-proposal step is where deals wait longest.</p>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px">
      <div style="padding: 18px; border: 1px solid #e5e6eb; border-radius: 12px"><p style="margin: 0; font-size: 12px; color: #646872">New pipeline</p><p style="margin: 4px 0 0; font-size: 26px; font-weight: 700">€410k</p></div>
      <div style="padding: 18px; border: 1px solid #e5e6eb; border-radius: 12px"><p style="margin: 0; font-size: 12px; color: #646872">Won</p><p style="margin: 4px 0 0; font-size: 26px; font-weight: 700">€96k</p></div>
      <div style="padding: 18px; border: 1px solid #e5e6eb; border-radius: 12px"><p style="margin: 0; font-size: 12px; color: #646872">Days, demo to proposal</p><p style="margin: 4px 0 0; font-size: 26px; font-weight: 700">19</p></div>
    </div>
    <h2 style="margin: 12px 0 0; font-size: 20px">What worked</h2>
    <ul style="margin: 0; padding-left: 22px">
      <li>Calling within a day of a demo request doubled the share of demos that happened.</li>
      <li>The two-minute opener from the cold call script got more people to stay on the line.</li>
      <li>Weekly pipeline reviews caught three stalled deals before they went quiet.</li>
    </ul>
    <h2 style="margin: 12px 0 0; font-size: 20px">What did not</h2>
    <ul style="margin: 0; padding-left: 22px">
      <li>Proposals waited on pricing questions nobody owned.</li>
      <li>Two deals were lost to a competitor's onboarding offer we never matched.</li>
    </ul>
    <h2 style="margin: 12px 0 0; font-size: 20px">Q4, three changes</h2>
    <ol style="margin: 0; padding-left: 22px">
      <li>One owner for pricing questions, answered within two days.</li>
      <li>A standard onboarding package priced into every proposal.</li>
      <li>Proposal sent within a week of the demo, or the deal is reviewed.</li>
    </ol>
    <div style="padding: 14px 16px; border-radius: 10px; background: #eeeefc; color: #2e2e8f">Target for Q4: <strong>€250k</strong> won, as on the pipeline canvas.</div>
  </main>
</body>
</html>
`;
  writeEntity('artboard', reviewBoard, {
    workspace_id: ws, page_id: review, kind: 'html', title: 'Q3 review one-pager', x: 0, y: 0, w: 1080, h: 720,
    content: REVIEW, sort_order: orderKey(null, null), created_by: ada,
  }, asAda);
  writeEntity('comment', uid(), {
    workspace_id: ws, page_id: review, author_id: grace, body: 'Can we name the pricing owner here before the board meeting?',
    anchor: { board: reviewBoard, x: 80, y: 820 }, reactions: {},
  }, { workspaceId: ws, actorId: grace, hlc: hlc(), system: true });

  const handbook = uid();
  writeEntity('page', handbook, {
    workspace_id: ws, title: 'Team handbook', icon: '📗', access: 'workspace', created_by: ada, status_id: settled,
    content: `# Team handbook

Welcome to Kolibri. This page is a normal wiki page — edit it, nest pages under it, drop images into it.

## How we work

- **Cycles** are two weeks. Anything not finished rolls over and gets re-estimated.
- **Priorities** mean urgency, not importance: \`urgent\` means someone is blocked right now.
- **Projects** own their own workflow states, so a design project can look nothing like the API project.

## Definition of done

1. Tests cover the new behaviour.
2. The change is documented where a user would look for it.
3. The task carries the cycle it shipped in.
`,
  }, { workspaceId: ws, actorId: ada, hlc: hlc(), system: true });

  writeEntity('page', uid(), {
    workspace_id: ws, parent_id: handbook, title: 'Incident response', icon: '🚨', created_by: grace, status_id: reading,
    content: `# Incident response

1. Declare the incident in the team channel.
2. File a task in **Public API** with priority \`urgent\`.
3. Post updates every 30 minutes in the task comments.
4. Write the postmortem as a child page here within two working days.
`,
  }, { workspaceId: ws, actorId: grace, hlc: hlc(), system: true });

  /*
   * One page in the demo that is HTML rather than markdown, because the whole
   * point of the format is the documents that arrive from somewhere else — a
   * supplier's specification, a page saved out of a browser, a table with a
   * colspan in it that markdown has no way to spell. A demo where every page is
   * markdown says the feature exists; a demo with one imported page in it shows
   * what it is for.
   */
  writeEntity('page', uid(), {
    workspace_id: ws, parent_id: handbook, title: 'Support hours (from the supplier)', icon: '📄',
    created_by: grace, format: 'html', status_id: settled,
    content: `<h2>Support hours</h2>
<p>Imported from the supplier's own document, kept as it was written.</p>
<table>
  <thead>
    <tr><th>Severity</th><th colspan="2">Response</th></tr>
    <tr><th></th><th>Office hours</th><th>Out of hours</th></tr>
  </thead>
  <tbody>
    <tr><td>Service down</td><td style="text-align:right">30 min</td><td style="text-align:right">1 h</td></tr>
    <tr><td>Degraded</td><td style="text-align:right">4 h</td><td style="text-align:right">next working day</td></tr>
    <tr><td>Question</td><td style="text-align:right">2 working days</td><td style="text-align:right">—</td></tr>
  </tbody>
</table>
<p>Escalation goes through the duty rota, <em>not</em> through the shared mailbox.</p>
`,
  }, { workspaceId: ws, actorId: grace, hlc: hlc(), system: true });

  writeEntity('page', uid(), {
    workspace_id: ws, project_id: projects[1].id, title: 'API design principles', icon: '🔌', created_by: grace,
    content: `# API design principles

- Resources are plural nouns, actions are HTTP verbs.
- Every list endpoint paginates by cursor.
- Breaking changes ship behind a new version prefix, never in place.
`,
  }, { workspaceId: ws, actorId: grace, hlc: hlc(), system: true });

  writeEntity('view', uid(), {
    workspace_id: ws, name: 'Urgent & unassigned', icon: '🔥', layout: 'list', owner_id: ada, shared: 1,
    filters: { priority: ['urgent', 'high'] }, group_by: 'priority', order_by: 'due_date',
  }, { workspaceId: ws, actorId: ada, hlc: hlc(), system: true });

  // If the instance was provisioned with an owner, let them see the demo too.
  const owner = get<Row>(`SELECT id FROM users WHERE is_admin = 1 AND id NOT IN (${ids.map(() => '?').join(',')})`, ...ids);
  if (owner) addMember(ws, owner.id, 'owner');

  console.log(`Seeded demo workspace "${workspace.name}" — sign in with ada@kolibri.dev / kolibri-demo`);
  return true;
}
