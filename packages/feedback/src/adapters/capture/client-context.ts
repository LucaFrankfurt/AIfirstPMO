// Browser facts collected at report time.
//
// Everything here is CLIENT-REPORTED and is labelled as such everywhere it surfaces
// (format.ts renders it in its own table under an explicit heading). None of it
// is trusted; it is captured because it is what makes a bug reproducible.
//
// WHAT IS DELIBERATELY NOT COLLECTED, and why — this list is the point of the module
// as much as the list above it:
//   - localStorage / sessionStorage / cookies: a second, unbounded data surface with
//     its own consent story, and a plausible route for session material to end up in
//     a ticket. Never.
//   - a console-log ring buffer: genuinely useful for JS errors and the natural v2,
//     but it is a second CAPTURE surface — it needs its own notice and its own
//     redaction question, which is exactly the discussion the screenshot already had.
//   - performance timings, font/plugin enumeration: fingerprinting-adjacent, and
//     nobody has ever reproduced a bug from them.
//
// Every reader is defensive: this runs on whatever browser a reporter happens to
// have, and a missing API must degrade to a null field rather than throw away the
// whole report.
import type { FeedbackClientContext } from '../../kernel/feedback/types.ts';

/** Optional Network Information API — Chrome/Android only, absent on Safari. */
interface NavigatorWithConnection extends Navigator {
  connection?: { effectiveType?: string };
}

/** Anything that can throw here yields `undefined`, never an exception. */
function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Collect the current view's context.
 *
 * `win` is injectable so this is testable in node without a DOM — the alternative
 * (a jsdom environment for one function) would pull a second test environment into a
 * suite that is deliberately node-only.
 */
export function collectClientContext(
  win: Window & typeof globalThis = globalThis as Window & typeof globalThis,
): FeedbackClientContext {
  const nav = win.navigator as NavigatorWithConnection | undefined;
  const doc = win.document as Document | undefined;

  return {
    url: safe(() => win.location?.href) ?? '',
    title: safe(() => doc?.title) ?? '',
    viewport: safe(() => `${win.innerWidth}x${win.innerHeight}`) ?? '',
    screen: safe(() => (win.screen ? `${win.screen.width}x${win.screen.height}` : '')) ?? '',
    devicePixelRatio: safe(() => win.devicePixelRatio) ?? 1,
    userAgent: safe(() => nav?.userAgent) ?? '',
    language: safe(() => nav?.language) ?? '',
    // Intl is present everywhere this app runs, but a locked-down browser can still
    // make resolvedOptions throw; the timezone is a nice-to-have, not a reason to fail.
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone) ?? '',
    online: safe(() => nav?.onLine) ?? true,
    // People work on mobile data; "it only breaks on 3g" is a real bug class.
    connection: safe(() => nav?.connection?.effectiveType) ?? null,
    // The CLIENT clock, deliberately alongside the server's own timestamp. Comparing
    // the two is free and explains a whole family of date/timezone bugs.
    clientTime: safe(() => new Date().toISOString()) ?? '',
  };
}
