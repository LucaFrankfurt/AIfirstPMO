/**
 * What is hung off the write path, in one list.
 *
 * `repo.ts` offers `onWrite` and knows nothing about who takes it up; this is
 * the other half — the single place that says which parts of the product react
 * to a row changing: the rules engine, the eight domains' entity rules, and the
 * two effects that leave the process.
 *
 * The last two are the reason `repo.ts` has a second hook. `onWrite` runs
 * inline because what a rule writes must land in the same transaction;
 * `onCommitted` runs after the commit because a notification has reached a
 * phone and a webhook has reached somebody else's server, and a rollback calls
 * back neither. Both used to be called from `afterWrite` by name, which is how
 * a write path came to hold notification copy and webhook payloads.
 *
 * Every entry point that can write calls this. There are two — the server and
 * the seed script — and they are named in `entryPoints` below so a third one
 * has something to be measured against. It is idempotent, so calling it twice
 * (a test that boots the server and also seeds) is not a bug.
 */
import { installAutomations } from './modules/automation/automation.ts';
import { installNotifications } from './modules/notifications/effects.ts';
import { installWebhookEvents } from './adapters/webhooks/effects.ts';
import { installBackends } from './backends.ts';
import { installPushDelivery } from './adapters/push/delivery.ts';
import { installTelegramDelivery } from './adapters/telegram/delivery.ts';
import { installAiProviders } from './adapters/ai/providers.ts';
import { installImapFetcher } from './adapters/imap/fetcher.ts';
import { installMailCorpus } from './modules/mail/corpus.ts';
import { installMailAuthProviders } from './adapters/oauth/mailbox.ts';
import { installTelegramChores } from './adapters/telegram/chores.ts';
import { installWebhookChores } from './adapters/webhooks/chores.ts';
import { onEntity } from './kernel/write-path/repo.ts';
import { budgetRules } from './modules/budgets/rules/budgets.ts';
import { kpiRules } from './modules/kpis/rules/kpis.ts';
import { landscapeRules } from './modules/infrastructure/rules/infrastructure.ts';
import { rateRules } from './modules/time/rules/rates.ts';
import { workRules } from './modules/work/rules/work.ts';
import { pageRules } from './modules/pages/rules/pages.ts';
import { chatRules } from './modules/chat/rules/chat.ts';
import { planningRules } from './modules/planning/rules/planning.ts';
import { mailRules } from './modules/mail/rules/mail.ts';

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
  installNotifications();
  installWebhookEvents();
  // The half every binary needs, including the ones that never write.
  installBackends();
  installPushDelivery();
  installTelegramDelivery();
  installAiProviders();
  installImapFetcher();
  installMailCorpus();
  installMailAuthProviders();
  installTelegramChores();
  installWebhookChores();
  // The order within an entity is the order they were branches in. Across
  // entities it cannot matter — one write is one entity. See `repo.onEntity`.
  for (const rule of [
    workRules, pageRules, chatRules, planningRules,
    budgetRules, rateRules, kpiRules, landscapeRules,
    mailRules,
  ]) onEntity(rule);
}
