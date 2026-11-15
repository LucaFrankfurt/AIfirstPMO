/**
 * What is hung off the sync engine, in one list.
 *
 * The client's half of `server/src/wiring.ts`, and it exists for the same
 * reason: `sync.ts` offers `onStream` and knows nothing about who takes it up,
 * so something has to say who does. A list that grows inside an entry point is
 * a list nobody reads.
 *
 * It is idempotent, and `wiring.test.ts` checks that the entry point calls it —
 * because a build that renders the app without installing these would look
 * perfectly fine and quietly show nobody as online.
 */
import { installNativeFiles } from './adapters/native/files';
import { installAppPush } from './adapters/push/app';
import { currentLocale, translate } from './kernel/i18n/i18n';
import { installPresence } from './modules/chat/presence';
import { installGuideHint } from './modules/guide/hint';

let installed = false;

export function installEffects(): void {
  if (installed) return;
  installed = true;
  installPresence();
  installGuideHint();
  installNativeFiles();
  // The channel's name is read when it is made, in whatever language is current then.
  installAppPush(() => translate(currentLocale(), 'push.channel'));
}
