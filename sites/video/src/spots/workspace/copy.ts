/**
 * What the Workspace explainer says.
 *
 * The features beat is a near-quotation of the docblock on `WorkspaceFeatures`,
 * and the roles beat of the `RANK` table in `auth.ts`. Both were written to
 * explain a decision to a person, which is usually a better marketing line than
 * one invented for the purpose.
 */
export const open = {
  section: 'Workspace',
  tagline: 'Everything belongs to one. Nothing leaks between two.',
} as const;

export const beats = {
  switcher: {
    kicker: 'One at a time',
    headline: 'Every row belongs to a workspace.',
    sub: 'Switching is not a filter over one pile — it is the pile changing. And your role can be different in each of them.',
  },
  roles: {
    kicker: 'Roles',
    headline: 'Four ranks, and one rule that is not a rank.',
    sub: 'Guest, member, admin, owner: each is everything the one below can do, and more. A workspace refuses to lose its last owner.',
  },
  features: {
    kicker: 'Features',
    headline: 'Off until somebody wants them.',
    sub: 'Time, budgets, the estate, KPIs, AI review and mail all start off. A feature that is on until you find the switch has already cluttered the screen of every team that did not want it.',
  },
  teams: {
    kicker: 'Teams',
    headline: 'Who works together.',
    sub: 'A team has a key and people, and projects answer to it. Who may read a project is still the project’s own business.',
  },
} as const;

export const close = {
  headline: 'One instance, as many workspaces as you need, and none of them sharing a row.',
} as const;
