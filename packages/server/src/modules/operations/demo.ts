/**
 * Demo data.
 *
 * Creates a workspace with two teams, three projects, a running cycle, a
 * backlog with realistic spread, wiki pages and comments — enough to see every
 * view populated on first launch. Run from the CLI with `npm run seed`, or
 * automatically on an empty database with KOLIBRI_SEED_DEMO=true.
 */
import { orderKey, orderKeys } from '@kolibri/shared';
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

  const handbook = uid();
  writeEntity('page', handbook, {
    workspace_id: ws, title: 'Team handbook', icon: '📗', access: 'workspace', created_by: ada,
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
    workspace_id: ws, parent_id: handbook, title: 'Incident response', icon: '🚨', created_by: grace,
    content: `# Incident response

1. Declare the incident in the team channel.
2. File a task in **Public API** with priority \`urgent\`.
3. Post updates every 30 minutes in the task comments.
4. Write the postmortem as a child page here within two working days.
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
