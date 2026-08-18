import { Clock, orderKeys, type StateGroup } from '@kolibri/shared';
import { get, run, tx, type Row } from '../db/index.ts';
import { conflict } from './http.ts';
import { translatorFor, type ServerKey } from './i18n.ts';
import { keyFromName, slugify, uid } from './ids.ts';
import { writeEntity } from './repo.ts';

/** Server-side clock used for writes that do not originate from a client. */
export const serverClock = new Clock('server');

/**
 * The workflow every new project starts with. The name is a translation key,
 * not a string: the first thing somebody sees in a fresh project should not be
 * in a language their team does not use. They are ordinary rows afterwards.
 */
export const DEFAULT_STATES: { name: ServerKey; group_key: StateGroup; color: string }[] = [
  { name: 'seed.stateBacklog', group_key: 'backlog', color: '#94a3b8' },
  { name: 'seed.stateTodo', group_key: 'unstarted', color: '#64748b' },
  { name: 'seed.stateInProgress', group_key: 'started', color: '#f59e0b' },
  { name: 'seed.stateInReview', group_key: 'started', color: '#8b5cf6' },
  { name: 'seed.stateDone', group_key: 'completed', color: '#10b981' },
  { name: 'seed.stateCancelled', group_key: 'cancelled', color: '#ef4444' },
];

const DEFAULT_LABELS: { name: ServerKey; color: string }[] = [
  { name: 'seed.labelBug', color: '#ef4444' },
  { name: 'seed.labelFeature', color: '#6366f1' },
  { name: 'seed.labelImprovement', color: '#0ea5e9' },
  { name: 'seed.labelDocumentation', color: '#14b8a6' },
];

export function createWorkspace(name: string, ownerId: string, slugHint?: string): Row {
  return tx(() => {
    const id = uid();
    let slug = slugify(slugHint || name);
    if (get(`SELECT id FROM workspaces WHERE slug = ?`, slug)) slug = `${slug}-${id.slice(0, 4)}`;
    const now = Date.now();
    run(
      `INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, name.trim() || 'Workspace', slug, ownerId, now, now,
    );
    addMember(id, ownerId, 'owner');
    return get<Row>(`SELECT * FROM workspaces WHERE id = ?`, id)!;
  });
}

export function addMember(workspaceId: string, userId: string, role = 'member'): Row {
  const existing = get<Row>(`SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?`, workspaceId, userId);
  if (existing) {
    if (existing.deleted_at || existing.role !== role) {
      writeEntity('member', existing.id, { role }, { workspaceId, actorId: userId, hlc: serverClock.now(), system: true });
    }
    return get<Row>(`SELECT * FROM workspace_members WHERE id = ?`, existing.id)!;
  }
  const { row } = writeEntity('member', uid(), { workspace_id: workspaceId, user_id: userId, role }, {
    workspaceId, actorId: userId, hlc: serverClock.now(), system: true,
  });
  // Every member joins the workspace's public projects so their inbox is useful.
  return row;
}

export interface NewProject {
  name: string;
  key?: string;
  description?: string;
  teamId?: string | null;
  icon?: string;
  color?: string;
  visibility?: 'public' | 'private';
  withDefaults?: boolean;
}

export function createProject(workspaceId: string, actorId: string, input: NewProject): Row {
  return tx(() => {
    const id = uid();
    const key = uniqueKey(workspaceId, input.key || keyFromName(input.name));
    const hlc = () => serverClock.now();
    const { row } = writeEntity('project', id, {
      workspace_id: workspaceId,
      team_id: input.teamId ?? null,
      name: input.name,
      key,
      description: input.description ?? null,
      icon: input.icon ?? '🚀',
      color: input.color ?? '#6366f1',
      lead_id: actorId,
      visibility: input.visibility ?? 'public',
      status: 'in_progress',
      sort_order: 'V',
    }, { workspaceId, actorId, hlc: hlc(), system: true });

    writeEntity('projectMember', uid(), { workspace_id: workspaceId, project_id: id, user_id: actorId, role: 'lead' },
      { workspaceId, actorId, hlc: hlc(), system: true });

    if (input.withDefaults !== false) {
      const t = translatorFor(actorId);
      const orders = orderKeys(DEFAULT_STATES.length);
      let firstStateId: string | null = null;
      let reviewStateId: string | null = null;
      DEFAULT_STATES.forEach((state, index) => {
        const stateId = uid();
        if (index === 0) firstStateId = stateId;
        if (state.name === 'seed.stateInReview') reviewStateId = stateId;
        writeEntity('state', stateId, {
          workspace_id: workspaceId, project_id: id, name: t(state.name),
          group_key: state.group_key, color: state.color, sort_order: orders[index],
        }, { workspaceId, actorId, hlc: hlc(), system: true });
      });
      for (const label of DEFAULT_LABELS) {
        writeEntity('label', uid(), { workspace_id: workspaceId, project_id: id, name: t(label.name), color: label.color },
          { workspaceId, actorId, hlc: hlc(), system: true });
      }
      if (firstStateId) {
        writeEntity('project', id, { default_state_id: firstStateId },
          { workspaceId, actorId, hlc: hlc(), system: true });
      }
      if (reviewStateId) seedFeedbackAutomation(workspaceId, id, actorId, reviewStateId, t);
    }
    return get<Row>(`SELECT * FROM projects WHERE id = ?`, row.id)!;
  });
}

/**
 * Every project starts able to ask for feedback.
 *
 * Enabled, because a rule nobody finds is a rule nobody uses — and because it
 * cannot fire until somebody moves a task into review, by which point the
 * project is being worked in. It goes to whoever leads the project and skips
 * the person who did the work, so on a one-person workspace it correctly does
 * nothing and says so in its run log. One switch in Settings turns it off.
 */
export function seedFeedbackAutomation(
  workspaceId: string,
  projectId: string,
  actorId: string,
  reviewStateId: string,
  t: (key: ServerKey, vars?: Record<string, string | number>) => string,
): { templateId: string; automationId: string } {
  const hlc = () => serverClock.now();
  const templateId = uid();
  writeEntity('template', templateId, {
    workspace_id: workspaceId,
    project_id: projectId,
    name: t('seed.feedbackTemplate'),
    kind: 'feedback',
    icon: '🔍',
    title: t('seed.feedbackTitle'),
    description: t('seed.feedbackBody'),
    priority: 'medium',
    subtasks: [t('seed.feedbackSub1'), t('seed.feedbackSub2'), t('seed.feedbackSub3')],
  }, { workspaceId, actorId, hlc: hlc(), system: true });

  const automationId = uid();
  writeEntity('automation', automationId, {
    workspace_id: workspaceId,
    project_id: projectId,
    name: t('seed.feedbackRule'),
    enabled: 1,
    trigger_kind: 'state_entered',
    trigger_state_id: reviewStateId,
    template_id: templateId,
    recipients: [{ kind: 'lead' }],
    fan_out: 'single',
    exclude_actor: 1,
    link_kind: 'relates_to',
  }, { workspaceId, actorId, hlc: hlc(), system: true });

  return { templateId, automationId };
}

function uniqueKey(workspaceId: string, desired: string): string {
  const base = desired.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'PRJ';
  let candidate = base;
  let n = 1;
  while (get(`SELECT id FROM projects WHERE workspace_id = ? AND key = ? AND deleted_at IS NULL`, workspaceId, candidate)) {
    candidate = `${base}${++n}`;
    if (n > 999) throw conflict('Could not allocate a project key');
  }
  return candidate;
}
