/**
 * What the Hierarchy explainer says.
 *
 * Two of these headlines are quotations. "Nesting is for reading, not for
 * access" is the comment on `Project.parent_id`; "empty means every project,
 * not none" is the comment on `Cycle.projects` and again on `Module.projects`.
 * Both are decisions somebody would otherwise have to discover by testing.
 */
export const open = {
  section: 'Hierarchy',
  tagline: 'Six levels, and the two rules that keep them honest.',
} as const;

export const beats = {
  tree: {
    kicker: 'The shape',
    headline: 'Workspace, team, project, task.',
    sub: 'A project brings its own states, cycles, modules and pages. A sub-task is a task, so the shape stops there rather than growing a new kind of thing.',
  },
  identifier: {
    kicker: 'Identifiers',
    headline: 'WEB-6 is a key and a number.',
    sub: 'The number counts within its project, which is why two projects can both have a task 5 — and why an identifier can be said out loud.',
  },
  nesting: {
    kicker: 'Nesting',
    headline: 'For reading, not for access.',
    sub: 'A project can sit under another, and a project can say it holds only projects. Neither of those changes who may read what.',
  },
  spanning: {
    kicker: 'Cycles and modules',
    headline: 'A sprint can cross projects.',
    sub: 'Name the projects it runs in — or name none at all, which means every one of them.',
  },
} as const;

export const close = {
  headline: 'Six levels, and every one of them a table you can read.',
} as const;
