/**
 * Render every carousel, and give the files names somebody can post.
 *
 * `remotion render --sequence` writes `element-0.png` … `element-9.png`, which
 * is the right name for a frame and the wrong one for a slide: it is zero-based
 * where the counter printed on the slide is one-based, and it sorts `element-10`
 * before `element-2` in every file picker there is. Somebody uploading nine
 * images to Instagram picks them in the order the picker shows them, so a name
 * that sorts wrong is not cosmetic — it publishes the deck out of order.
 *
 * So this renders each set and renames as it goes: `pitch-01.png` … `pitch-08.png`,
 * zero-padded, matching the “1 / 8” drawn on the slide itself.
 *
 *   node scripts/social.mjs              # all of them
 *   node scripts/social.mjs pitch        # one
 *
 * `CHROMIUM_PATH` is honoured by `remotion.config.ts`, the same as everywhere
 * else in this repository.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('..', import.meta.url).pathname;

/** Slug → composition id. The slug is the folder and the file prefix. */
const SETS = {
  pitch: 'SocialPitch',
  quickadd: 'SocialQuickAdd',
  offline: 'SocialOffline',
  hierarchy: 'SocialHierarchy',
  assistant: 'SocialAssistant',
  selfhost: 'SocialSelfHost',
  singles: 'SocialSingles',
};

const wanted = process.argv.slice(2);
const chosen = wanted.length ? wanted : Object.keys(SETS);

for (const slug of chosen) {
  const id = SETS[slug];
  if (!id) {
    console.error(`Unknown set "${slug}". One of: ${Object.keys(SETS).join(', ')}`);
    process.exit(1);
  }

  const dir = join(HERE, 'out', 'social', slug);
  /* Emptied first, so a set that loses a slide does not leave the old last one
   * behind for somebody to upload. */
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const run = spawnSync(
    'npx',
    ['remotion', 'render', 'src/index.ts', id, `out/social/${slug}`, '--sequence', '--image-format=png'],
    { cwd: HERE, stdio: 'inherit' },
  );
  if (run.status !== 0) process.exit(run.status ?? 1);

  const frames = readdirSync(dir)
    .filter((name) => name.startsWith('element-') && name.endsWith('.png'))
    .map((name) => ({ name, n: Number(name.slice('element-'.length, -'.png'.length)) }))
    .sort((a, b) => a.n - b.n);

  for (const frame of frames) {
    const number = String(frame.n + 1).padStart(2, '0');
    renameSync(join(dir, frame.name), join(dir, `${slug}-${number}.png`));
  }
  console.log(`  ${slug}: ${frames.length} slides → out/social/${slug}/${slug}-01.png …`);
}
