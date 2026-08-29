// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

/*
 * docs.kolibri.day — the manual for *using* Kolibri.
 *
 * The markdown under `docs/` in the repository root is a different document
 * and deliberately stays there: it is the manual for *running and extending*
 * an instance — the sync protocol, the threat model, the environment
 * variables. This site is for the person who has been handed a login and a
 * board, and it is written from scratch rather than generated from those
 * files, because the two audiences want opposite things from the same
 * feature. `docs/notifications.md` explains the retry queue; the page here
 * explains how to stop being emailed at midnight.
 */
export default defineConfig({
  site: 'https://docs.kolibri.day',
  // Trailing slashes are what a static file server hands out for a directory,
  // so say so and let every internal link agree with the server rather than
  // relying on a redirect that a plain nginx will not perform.
  trailingSlash: 'always',
  build: { format: 'directory' },

  /*
   * A Content-Security-Policy with no `unsafe-inline`.
   *
   * Starlight cannot do without inline script — the theme is resolved before
   * the first paint, or the page flashes — and the usual way to allow that is
   * `'unsafe-inline'`, which allows every other inline script too. Astro
   * hashes the ones it emitted and writes them into a `<meta http-equiv>`
   * instead, so an injected `<script>` has no matching hash and does not run.
   *
   * Two of the directives below are Pagefind's, and neither is decoration:
   * the search index is read by a **web worker** created from a blob, and the
   * index itself is **WebAssembly**. Without `worker-src blob:` and
   * `'wasm-unsafe-eval'` the search box opens and finds nothing, with the
   * reason only in the console — which is exactly the kind of failure a
   * policy should not be allowed to cause quietly.
   */
  security: {
    csp: {
      directives: [
        "default-src 'none'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
      ],
      scriptDirective: {
        resources: ["'self'", "'wasm-unsafe-eval'"],
      },
      /*
       * `'unsafe-inline'` for styles, and only for styles.
       *
       * Pagefind — the search index Starlight builds — injects its own
       * stylesheet at runtime, after the build that could have hashed it. With
       * the policy strict, every keystroke in the search box logged a
       * refusal; nothing looked wrong, because Starlight overrides those rules
       * anyway, but a docs site that prints twenty console errors per search
       * is one people file bugs about.
       *
       * The trade is worth naming rather than hiding: an injected `<style>`
       * can read attribute values through selectors and leak them as
       * background-image requests. On a static site with no session, no form
       * and no user input, there is nothing in the DOM to leak — and
       * `script-src` above stays hash-locked, which is the directive that
       * actually stops code running.
       */
      styleDirective: {
        resources: ["'self'", "'unsafe-inline'"],
      },
    },
  },
  integrations: [
    starlight({
      title: 'Kolibri',
      description:
        'How to use Kolibri: tasks, boards, cycles, pages, chat and the offline sync — the manual for the person doing the work.',
      tagline: 'The manual for the person doing the work',
      logo: { src: './src/assets/kolibri-mark.png', alt: '' },
      favicon: '/favicon.ico',
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0e1014', media: '(prefers-color-scheme: dark)' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#ffffff', media: '(prefers-color-scheme: light)' } },
      ],
      customCss: ['./src/styles/kolibri.css'],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/LucaFrankfurt/AIfirstPMO' },
      ],
      editLink: {
        baseUrl: 'https://github.com/LucaFrankfurt/AIfirstPMO/edit/main/sites/docs/',
      },
      lastUpdated: true,
      credits: false,
      pagination: true,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      components: {
        // The only override, and it adds rather than replaces: the stock
        // social icons plus a link to the live demo. Most of what is written
        // here is easier to believe with a board open beside it.
        SocialIcons: './src/components/SocialIcons.astro',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What Kolibri is', slug: 'start' },
            { label: 'Your first hour', slug: 'start/first-hour' },
            { label: 'How it is put together', slug: 'start/shape' },
            { label: 'Getting an instance', slug: 'start/instance' },
          ],
        },
        {
          label: 'Tasks',
          items: [
            { label: 'Making a task', slug: 'tasks' },
            { label: 'The task itself', slug: 'tasks/detail' },
            { label: 'Custom fields', slug: 'tasks/custom-fields' },
            { label: 'Comments and mentions', slug: 'tasks/comments' },
            { label: 'Changing many at once', slug: 'tasks/bulk' },
          ],
        },
        {
          label: 'Seeing the work',
          items: [
            { label: 'The five layouts', slug: 'views' },
            { label: 'Group, filter, sort', slug: 'views/filtering' },
            { label: 'Saved views', slug: 'views/saved' },
            { label: 'Search', slug: 'views/search' },
          ],
        },
        {
          label: 'Planning',
          items: [
            { label: 'Cycles', slug: 'planning/cycles' },
            { label: 'Modules', slug: 'planning/modules' },
            { label: 'The timeline', slug: 'planning/timeline' },
            { label: 'Insights', slug: 'planning/insights' },
            { label: 'Time tracking', slug: 'planning/time' },
            { label: 'Timesheet and cost', slug: 'planning/timesheet' },
            { label: 'Infrastructure', slug: 'planning/infrastructure' },
            { label: 'Budgets', slug: 'planning/budgets' },
            { label: 'Across projects', slug: 'planning/portfolio' },
          ],
        },
        {
          label: 'Pages',
          items: [
            { label: 'Writing pages', slug: 'pages' },
            { label: 'Two people, one page', slug: 'pages/together' },
            { label: 'History and restore', slug: 'pages/history' },
            { label: 'Sharing a page', slug: 'pages/sharing' },
          ],
        },
        {
          label: 'Things that happen by themselves',
          items: [
            { label: 'Task templates', slug: 'automation/templates' },
            { label: 'Repeating tasks', slug: 'automation/repeating' },
            { label: 'Rules', slug: 'automation/rules' },
          ],
        },
        {
          label: 'People',
          items: [
            { label: 'Chat', slug: 'people/chat' },
            { label: 'Notifications', slug: 'people/notifications' },
            { label: 'Intake forms', slug: 'people/intake' },
            { label: 'Members and roles', slug: 'people/members' },
          ],
        },
        {
          label: 'Off the beaten path',
          items: [
            { label: 'Working offline', slug: 'beyond/offline' },
            { label: 'On your phone', slug: 'beyond/mobile' },
            { label: 'Calendar subscriptions', slug: 'beyond/calendar' },
            { label: 'Bringing a backlog in', slug: 'beyond/import' },
            { label: 'Taking it with you', slug: 'beyond/export' },
            { label: 'Connecting an assistant', slug: 'beyond/assistant' },
            { label: 'Asking a model to read a task', slug: 'beyond/task-reviews' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Keyboard shortcuts', slug: 'reference/shortcuts' },
            { label: 'Quick-add syntax', slug: 'reference/quick-add' },
            { label: 'Filter language', slug: 'reference/filters' },
            { label: 'Words used here', slug: 'reference/glossary' },
          ],
        },
      ],
    }),
  ],
});
