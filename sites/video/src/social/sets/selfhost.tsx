/**
 * What "self-hosted" costs, stated as numbers rather than as a promise.
 *
 * Everybody's landing page says self-hosting is easy. The only interesting
 * version of that claim is the one with the dependency list in it, so this set
 * is mostly counts: one command, one process, one file, one directory, and a
 * server whose `package.json` has exactly one dependency and it is this
 * repository's own shared package.
 *
 * Every line is the README's quick start or `docs/architecture.md`. The reader
 * this is for will check.
 */
import { command } from '../../product';
import type { Carousel } from '../slide';

export const selfhost: Carousel = {
  id: 'SocialSelfHost',
  about: 'what self-hosting actually costs — one command, one process, one file, one directory',
  slides: [
    {
      kind: 'cover',
      kicker: 'Self-hosted',
      headline: 'The whole installation is one command.',
      sub: 'Not one command and then a database, a cache and a queue. One.',
      chips: ['Docker Compose v2', 'or Node 22.18+'],
    },
    {
      kind: 'point',
      kicker: 'The install',
      headline: 'Clone it, bring it up, open it.',
      sub: 'It brings up the app and an S3-compatible object store for uploads, already wired to each other — the bucket is created on first boot and nothing has to be configured afterwards.',
      /*
       * The README clones into a directory called `kolibri`; the slide takes
       * the default name instead, because `… AIfirstPMO.git kolibri` is
       * sixty-three characters and wraps onto a third line that reads as a
       * command of its own.
       */
      code: `git clone https://github.com/LucaFrankfurt/AIfirstPMO\ncd AIfirstPMO\n${command}\nopen http://localhost:4000`,
    },
    {
      kind: 'point',
      kicker: 'The stack',
      headline: 'One Node process and a SQLite file.',
      sub: 'No Postgres, no Redis, no worker queue, no separate scheduler. Strip it down to a single container when that is all you want.',
    },
    {
      kind: 'point',
      kicker: 'Dependencies',
      headline: 'The server has none.',
      sub: 'Not “few”. Its package.json lists one, and that one is this repository’s own shared package. SQLite is built into Node 22, and the server runs TypeScript directly — nothing is compiled, bundled or installed at boot.',
      code: '"dependencies": { "@kolibri/shared": "*" }',
    },
    {
      kind: 'point',
      kicker: 'Your data',
      headline: 'One directory. Copy it and you have moved.',
      sub: 'The database, the uploads and the keys sit under KOLIBRI_DATA_DIR. A backup is a file copy, and a restore is putting it back.',
    },
    {
      kind: 'point',
      kicker: 'And if you would rather not',
      headline: 'There is a demo with a workspace already in it.',
      sub: 'A real instance, wiped back to its starting state on a schedule. Nothing to install to find out whether you want it.',
    },
    {
      kind: 'close',
      kicker: 'MIT',
      headline: 'Your instance, your data, your licence.',
      sub: 'No seats, no tiers, and no feature behind a sales call.',
      code: command,
    },
  ],
};
