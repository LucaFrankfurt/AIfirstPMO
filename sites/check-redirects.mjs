/**
 * The redirect both sites depend on, and the one nothing else tests.
 *
 * Every page is a directory — `trailingSlash: 'always'` — so a link that
 * arrives without the slash is answered with a 301 built by nginx. Left at its
 * default, nginx puts an absolute URL in that header, assembled from the host
 * it was asked for and *the port it is listening on*. Behind a proxy that
 * terminates TLS, that is the container's private 8080 and the scheme `http`,
 * neither of which is where the visitor is. They land on a dead address.
 *
 * Nothing else in this repository could catch it. The browser checks run
 * against `serve`, which has different redirect behaviour, and the built `dist`
 * directory the other scripts read has no server in it at all — the bug lives
 * entirely in the four lines of configuration between them.
 *
 * So this asserts the configuration, always, and the behaviour when there is an
 * nginx to ask:
 *
 *   node sites/check-redirects.mjs
 *
 * With nginx installed it starts one on the repository's own `nginx.conf`,
 * requests a directory without its slash and reads the `Location` back. Without
 * it, the configuration assertion still runs and the rest says it was skipped
 * rather than passing quietly.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const config = readFileSync(join(here, 'nginx.conf'), 'utf8');
let failed = 0;
const ok = (message) => console.log(`  ok   ${message}`);
const bad = (message) => { failed++; console.log(`  FAIL ${message}`); };

/* -------------------------------------------------------- the configuration */

// Comments do not count: the directive has to be in force, not described.
const live = config.replace(/^\s*#.*$/gm, '');
if (/\babsolute_redirect\s+off\s*;/.test(live)) {
  ok('nginx.conf turns absolute redirects off');
} else {
  bad('nginx.conf does not set `absolute_redirect off` — a 301 will carry the container port');
}
if (/\babsolute_redirect\s+on\s*;/.test(live)) {
  bad('nginx.conf turns absolute redirects back on somewhere');
}

/* ------------------------------------------------------------ the behaviour */

const nginx = spawnSync('nginx', ['-v'], { encoding: 'utf8' });
if (nginx.error) {
  console.log('\nNo nginx here — the served check is skipped.');
  console.log('  Install one (`apt-get install nginx-light`) to run it.');
  process.exit(failed ? 1 : 0);
}

const root = mkdtempSync(join(tmpdir(), 'kolibri-redirects-'));
try {
  // A page, the way both sites emit one: a directory with an index in it.
  mkdirSync(join(root, 'html/planning/cycles'), { recursive: true });
  writeFileSync(join(root, 'html/planning/cycles/index.html'), '<!doctype html><title>x</title>');
  execFileSync('chmod', ['-R', 'a+rX', root]);

  const port = 18_080;
  const conf = join(root, 'nginx.conf');
  writeFileSync(conf, config
    .replace('pid        /tmp/nginx.pid;', `pid ${root}/nginx.pid;`)
    .replace(/\/tmp\/(client_body|proxy|fastcgi|uwsgi|scgi)/g, `${root}/$1`)
    .replace('root         /usr/share/nginx/html;', `root ${root}/html;`)
    .replace('error_log  /dev/stderr  warn;', `error_log ${root}/error.log warn;`)
    .replace('access_log  /dev/stdout  main;', `access_log ${root}/access.log main;`)
    // The port, and only the port: a sandbox may have no IPv6 to listen on, and
    // this is a question about a header rather than about address families.
    .replace(/listen\s+\[::\]:8080;/, '')
    .replace(/listen\s+8080;/, `listen ${port};`));

  execFileSync('nginx', ['-c', conf]);
  try {
    // Asked for over https, through a proxy, without the trailing slash — which
    // is how a link in somebody's notes or another site's page usually arrives.
    const response = await fetch(`http://127.0.0.1:${port}/planning/cycles`, {
      redirect: 'manual',
      headers: { host: 'docs.kolibri.day', 'x-forwarded-proto': 'https' },
    });
    const location = response.headers.get('location') ?? '';
    console.log(`\n  301 → ${location || '(no Location header)'}`);

    if (response.status !== 301) bad(`expected a 301 for a directory without its slash, got ${response.status}`);
    else if (location.startsWith('/')) ok('the redirect is relative, so the browser keeps its own scheme, host and port');
    else if (/:\d+/.test(location)) bad(`the redirect carries a port: ${location}`);
    else bad(`the redirect is absolute: ${location}`);
  } finally {
    spawnSync('nginx', ['-c', conf, '-s', 'stop']);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} problem(s)` : '\nRedirects are safe behind a proxy.');
process.exit(failed ? 1 : 0);
