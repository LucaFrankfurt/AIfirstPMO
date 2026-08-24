// @ts-check
import { defineConfig } from 'astro/config';

/*
 * demo.kolibri.day — the page in front of the live demo.
 *
 * It is deliberately a separate Astro project from `sites/docs` rather than a
 * page inside it. The two want opposite things: a docs site wants a framework
 * with a sidebar, a search index and forty pages; this wants one page, no
 * JavaScript at all, and to load on a conference wifi before the talk moves on.
 * Sharing a build would mean one of them carrying the other's weight.
 */
export default defineConfig({
  site: 'https://demo.kolibri.day',
  trailingSlash: 'always',
  build: { format: 'directory', inlineStylesheets: 'always' },

  /*
   * A Content-Security-Policy with no `unsafe-inline`.
   *
   * This page has two inline scripts it cannot do without — the one that reads
   * the stored theme before the first paint, and the copy button — and the
   * usual way to allow them is `'unsafe-inline'`, which allows every *other*
   * inline script too. Astro hashes the ones it emitted instead and writes
   * them into a `<meta http-equiv>`, so an injected `<script>` has no matching
   * hash and does not run.
   *
   * The app itself ships a policy with no inline script at all (see
   * `docs/security.md`); this is the same intent under a static host, which
   * has no server to add a nonce per request.
   *
   * `frame-ancestors`, `report-uri` and `sandbox` are ignored in a `<meta>`
   * policy by specification, so those live in the nginx config beside it.
   */
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        // Every outbound link on this page is a full URL to another origin, so
        // nothing here needs to be framed or to frame anything.
        "object-src 'none'",
      ],
    },
  },
});
