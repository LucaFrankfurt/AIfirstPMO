/**
 * What is hung off the write path, in one list.
 *
 * `repo.ts` offers `onWrite` and knows nothing about who takes it up; this is
 * the other half — the single place that says which parts of the product react
 * to a row changing. Today that is the rules engine and only the rules engine.
 * Under the module contract in `docs/modules.md` it is where each capability's
 * `effects` would register, which is why it is a file of its own rather than
 * three lines in `index.ts`: the list is going to grow, and a list that grows
 * inside an entry point is a list nobody reads.
 *
 * Every entry point that can write calls this. There are two — the server and
 * the seed script — and they are named in `entryPoints` below so a third one
 * has something to be measured against. It is idempotent, so calling it twice
 * (a test that boots the server and also seeds) is not a bug.
 */
import { installAutomations } from './modules/automation/automation.ts';
import { onEntity } from './kernel/write-path/repo.ts';
import { budgetRules } from './modules/budgets/rules/budgets.ts';
import { kpiRules } from './modules/kpis/rules/kpis.ts';
import { landscapeRules } from './modules/infrastructure/rules/infrastructure.ts';
import { rateRules } from './modules/time/rules/rates.ts';
import { workRules } from './modules/work/rules/work.ts';
import { pageRules } from './modules/pages/rules/pages.ts';
import { chatRules } from './modules/chat/rules/chat.ts';
import { planningRules } from './modules/planning/rules/planning.ts';

let installed = false;

/**
 * The entry points that must call `installEffects`, for `wiring.test.ts` to
 * check against. A binary that writes rows without wiring the effects up would
 * behave differently from the server for reasons nobody could see in the diff.
 */
export const entryPoints = ['src/index.ts', 'src/seed.ts'] as const;

export function installEffects(): void {
  if (installed) return;
  installed = true;
  installAutomations();
  // The order within an entity is the order they were branches in. Across
  // entities it cannot matter — one write is one entity. See `repo.onEntity`.
  for (const rule of [
    workRules, pageRules, chatRules, planningRules,
    budgetRules, rateRules, kpiRules, landscapeRules,
  ]) onEntity(rule);
}
