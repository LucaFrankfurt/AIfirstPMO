// Client-side screenshot capture of the CURRENT VIEWPORT.
//
// TWO RENDERERS, TRIED IN ORDER — not a platform split.
//   1. modern-screenshot (foreignObject): serializes the DOM into an SVG and lets the
//      BROWSER'S OWN ENGINE draw it. Measured against Chromium's real screenshot of
//      the same page it scores a mean absolute error of 0.51 with 0.52% of pixels
//      materially off, versus html2canvas's 2.48 / 2.05% — roughly 5x closer. It also
//      gets natively right the things html2canvas fabricates: a closed <details> stays
//      closed, <summary> keeps its ▶ instead of a bogus "1.", native <select> arrows
//      and checkboxes render as themselves.
//   2. html2canvas: the fallback, kept because foreignObject has a history of Safari
//      bugs that CANNOT be tested from a headless environment, and iPhones are exactly
//      what people report bugs from. Selection is by OUTCOME, not by sniffing the platform: if the
//      first renderer throws or returns something unusable, we quietly use the second.
//      A user-agent test would guess; this observes.
//
// WHY NOT getDisplayMedia (re-evaluated after repeated fidelity complaints, and still
// the answer): it is genuinely pixel-exact, and that is a real advantage. But it is
// UNSUPPORTED ON iOS SAFARI — undefined, not degraded — so it can never be the only
// mechanism for this userbase; it prompts on every single report; and it can make the
// PRIVACY POSTURE WORSE rather than better, because `preferCurrentTab` is only a hint
// and one mis-click shares an entire desktop (mail, chat) into a shared tracker
// project. A DOM render is bounded to this app's own markup by construction. If
// pixel-exactness is still wanted, the next step is an OPT-IN "take a real
// screenshot" button on desktop, leaving this silent path as the default everywhere.
//
// Remaining honest limits of any DOM render: cross-origin images cannot be inlined, so
// a map view still has holes where third-party tiles are (the surrounding chrome
// captures fine, which is usually where the bug is).
//
// Both renderers are DYNAMICALLY IMPORTED at capture time, so neither enters the main
// bundle — people on mobile data do not pay for a feature they have not opened. They
// are optional peer dependencies of this package: install `modern-screenshot` and
// `html2canvas` in the app that captures.

/**
 * Longest edge of an uploaded screenshot, in pixels.
 *
 * DO NOT LOWER THIS BACK toward ~1600 by reasoning about photo file sizes — that was
 * the original mistake and it produced a real, reported defect.
 *
 * This started at 1600, sized against "a full-page PNG can be 2-6 MB". That is true of
 * PHOTOGRAPHIC content and false of a UI screenshot in WebP: measured on a
 * data-table page, the full-resolution 2560x1440 capture encodes to ~30 KB — against
 * a 1 MB target. So the old cap bought nothing and cost legibility: a 2560-wide
 * desktop was downscaled by 0.625, turning 12px badge text into 7.5px and smearing
 * white-on-near-black labels into unreadable dark blocks.
 *
 * That was confirmed to be the RESIZE, not the encoder: the same downscale applied to
 * a pixel-perfect browser screenshot smears identically, and lossless PNG at 1600
 * smears just as badly. Only stopping the downscale fixes it.
 *
 * 2560 rather than unlimited: it still bounds an ultrawide or scaled-up display,
 * where a capture genuinely can get large. Everything below it is now 1:1.
 */
export const MAX_EDGE_PX = 2560;
/** Target ceiling for the encoded blob; the encoder steps quality down to reach it. */
export const TARGET_MAX_BYTES = 1_000_000;
/** Absolute client-side refusal (the server independently enforces its own cap). */
export const HARD_MAX_BYTES = 2_000_000;

/**
 * THE EXCLUSION CONTRACT: anything carrying this attribute is dropped from the capture
 * by both renderers — the report dialog and its backdrop, the trigger button, a menu
 * mid-animation, and any app data that must never appear in a screenshot.
 */
export const REDACT_ATTRIBUTE = 'data-feedback-redact';

export interface CaptureOptions {
  /** Attribute that excludes a subtree from the capture. Default: `data-feedback-redact`. */
  redactAttribute?: string;
  /** Longest edge in pixels. Default: MAX_EDGE_PX — read its comment before lowering it. */
  maxEdge?: number;
  /** Encoded size the quality ladder aims for. Default: TARGET_MAX_BYTES. */
  targetBytes?: number;
  /** Larger results are discarded (the report goes without a screenshot). Default: HARD_MAX_BYTES. */
  hardMaxBytes?: number;
}

/**
 * Encoder quality ladder. 0.92 is the working value — fine light-on-dark text is the
 * first thing to go, and it survives cleanly there. The lower rungs are a BACKSTOP for
 * an unexpectedly heavy page (an image-rich view), not the normal path; a typical UI
 * screenshot never leaves the first rung.
 */
const QUALITY_STEPS = [0.92, 0.8, 0.65];

export interface CaptureResult {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Target dimensions after downscaling. Pure — this is the arithmetic the tests pin
 * down, separated from any canvas.
 *
 * Never upscales: a small phone viewport is already the size it is, and enlarging it
 * would inflate the payload while adding exactly zero detail.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE_PX,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const factor = maxEdge / longest;
  // Floor + a floor of 1: rounding could land a hair over maxEdge, and a zero
  // dimension would make the canvas throw.
  return { width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor)) };
}

/**
 * Did the canvas actually encode the type we asked for?
 *
 * A canvas asked for a type it cannot encode does not fail — it silently returns PNG
 * instead. So the requested type is not evidence of anything; `blob.type` is. An
 * empty type (very old engines) is taken at its word.
 */
export function isRequestedType(produced: string, requested: string): boolean {
  return produced === '' || produced === requested;
}

/** Draw `source` into a downscaled canvas. Separated so capture() stays readable. */
function downscale(source: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const { width, height } = fitWithin(source.width, source.height, maxEdge);
  if (width === source.width && height === source.height) return source;

  const target = document.createElement('canvas');
  target.width = width;
  target.height = height;
  const ctx = target.getContext('2d');
  if (!ctx) return source;
  // Smooth downsampling; the default is already 'low' in some engines and text
  // suffers noticeably at these ratios.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return target;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Encode, stepping quality down until the blob fits `targetBytes`.
 *
 * Formats in order of preference: WebP (visibly better than JPEG on UI text at the
 * same size), then JPEG. A format counts as supported only if the browser actually
 * produced it (isRequestedType): a browser that cannot encode WebP hands back a PNG
 * rather than null, and taking that PNG as "WebP done" used to skip JPEG entirely —
 * leaving such browsers with an uncompressible PNG and a quality ladder that did
 * nothing. A substituted PNG is kept only as the last resort, when neither lossy
 * format is available.
 *
 * Terminates unconditionally: the ladder is finite, and the smallest blob of the
 * supported format is returned whether or not it met the target — the caller (and the
 * server) enforce the hard cap.
 */
export async function encodeWithinBudget(
  canvas: HTMLCanvasElement,
  targetBytes: number = TARGET_MAX_BYTES,
): Promise<Blob | null> {
  let substitute: Blob | null = null;
  for (const type of ['image/webp', 'image/jpeg']) {
    let smallest: Blob | null = null;
    for (const quality of QUALITY_STEPS) {
      const blob = await toBlob(canvas, type, quality);
      if (!blob) break; // cannot encode this type at all
      if (!isRequestedType(blob.type, type)) {
        substitute ??= blob; // unsupported — the browser fell back to PNG
        break;
      }
      if (blob.size <= targetBytes) return blob;
      if (!smallest || blob.size < smallest.size) smallest = blob;
    }
    if (smallest) return smallest; // supported, just heavy: the best this format can do
  }
  return substitute;
}

/** Should this element be kept out of the capture entirely? */
function isRedacted(el: Element, attribute: string): boolean {
  return el.nodeType === 1 && (el as HTMLElement).hasAttribute?.(attribute) === true;
}

/**
 * A render is "usable" if it has real pixels. foreignObject failures are quiet — a
 * browser that chokes on the serialized SVG hands back a blank or zero-sized canvas
 * rather than throwing — so a try/catch alone would let a white rectangle through and
 * call it a screenshot. This is what makes the fallback trigger on the failure mode
 * that actually happens.
 */
export function looksUsable(canvas: HTMLCanvasElement): boolean {
  if (canvas.width < 2 || canvas.height < 2) return false;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    // Sample a coarse grid rather than every pixel: enough to tell "drew something"
    // from "drew nothing", cheap enough to run on every capture.
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const step = Math.max(4, Math.floor((canvas.width * canvas.height) / 5000)) * 4;
    let first = -1;
    for (let i = 0; i < data.length; i += step) {
      const lum = (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0);
      if (first === -1) first = lum;
      else if (Math.abs(lum - first) > 12) return true; // some variation ⇒ real content
    }
    return false; // uniform ⇒ blank
  } catch {
    // Tainted canvas (a cross-origin image got in). Unreadable here, and unencodable
    // later — treat as unusable so the other renderer gets its turn.
    return false;
  }
}

/**
 * Preferred renderer: modern-screenshot, via foreignObject.
 *
 * The browser draws it, so UA behaviour (a closed `<details>`, `<summary>`'s marker,
 * native form controls) is correct for free — no clone patching required.
 *
 * Scroll handling differs from html2canvas, which takes x/y/scroll options: here the
 * clone is translated by the scroll offset and the output box fixed to the viewport,
 * which crops to the visible region.
 */
async function renderWithModernScreenshot(attribute: string): Promise<HTMLCanvasElement | null> {
  const { domToCanvas } = await import('modern-screenshot');
  const canvas = await domToCanvas(document.documentElement, {
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    scale: 1,
    style: {
      transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
      transformOrigin: 'top left',
    },
    // Same redaction contract as the html2canvas path — `filter` returns false to drop
    // a node. Keeping both honour one attribute is what stops the two renderers from
    // disagreeing about what is sensitive.
    filter: (node: Node) => !(node instanceof Element && isRedacted(node, attribute)),
  });
  return canvas ?? null;
}

/** The slice of html2canvas's API this file uses. */
type Html2Canvas = (element: HTMLElement, options?: Record<string, unknown>) => Promise<HTMLCanvasElement>;

/**
 * html2canvas ships CommonJS with an ES-module build beside it. A bundler picks the
 * ES build, where the function IS the default export; Node's own ESM-to-CJS interop
 * wraps `module.exports` once more, so there it sits at `.default.default`. Accept
 * both rather than depend on which one the consuming app's tooling chose.
 */
async function loadHtml2Canvas(): Promise<Html2Canvas> {
  const mod = (await import('html2canvas')) as unknown as { default: Html2Canvas | { default: Html2Canvas } };
  return typeof mod.default === 'function' ? mod.default : mod.default.default;
}

/**
 * Fallback renderer: html2canvas.
 *
 * Needs the clone patched (see neutralizeCollapsedDetails) because it re-implements
 * layout from computed styles. That workaround stays here, and ONLY here — deleting it
 * along with the switch to modern-screenshot would quietly reintroduce the original
 * over-painted-filter-panel bug for anyone whose browser lands on this path.
 */
async function renderWithHtml2Canvas(attribute: string): Promise<HTMLCanvasElement | null> {
  const html2canvas = await loadHtml2Canvas();
  return html2canvas(document.body, {
    // Anything the app marks as sensitive never enters the render — the permanent
    // hook for excluding e.g. a salary column from every screenshot. The trigger
    // button and the report dialog carry the same attribute.
    ignoreElements: (el: Element) => isRedacted(el, attribute),
    onclone: neutralizeCollapsedDetails,
    // CSS pixels, not devicePixelRatio. (Sharpening mobile captures by rendering at
    // DPR is a possible enhancement, deliberately not done here.)
    scale: 1,
    useCORS: true,
    // Cross-origin images that can't be read taint the canvas and make toBlob throw;
    // dropping them costs a blank rectangle and saves the whole capture.
    allowTaint: false,
    logging: false,
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    // The visible window only.
    x: window.scrollX,
    y: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    windowWidth: document.documentElement.clientWidth,
    windowHeight: document.documentElement.clientHeight,
    scrollX: 0,
    scrollY: 0,
  });
}

/**
 * Make a COLLAPSED `<details>` actually look collapsed in the capture.
 *
 * html2canvas walks the DOM and paints anything whose COMPUTED STYLE says it is
 * visible. But a closed `<details>` is collapsed by the user agent — the content lives
 * in a slot the browser simply doesn't paint — and that is not expressed in CSS at
 * all. Measured on a closed panel: `display: flex`, `visibility: visible`,
 * `content-visibility: visible`, and a full 950x82 bounding rect. So html2canvas has
 * every reason to draw it, and does — over whatever follows.
 *
 * That produced a reported defect: a closed "more filters" panel was painted on top of
 * the table header, making the screenshot actively misleading (it showed filter fields
 * the reporter never had open).
 *
 * The `<summary>` line is the same root cause wearing a different hat: `summary` is
 * `display: list-item`, and html2canvas renders that marker as an ORDERED-LIST NUMBER,
 * so a stray "1." appeared beside the panel's title. Forcing `display: block` drops the
 * marker box. The cost is losing the ▶ disclosure triangle, which html2canvas cannot
 * draw anyway — a missing triangle beats a fabricated "1.".
 *
 * Mutates the CLONE html2canvas renders from, never the live document.
 */
function neutralizeCollapsedDetails(doc: Document): void {
  doc.querySelectorAll('details:not([open])').forEach((details) => {
    for (const child of Array.from(details.children)) {
      if (child.tagName !== 'SUMMARY') (child as HTMLElement).style.display = 'none';
    }
  });
  doc.querySelectorAll('summary').forEach((summary) => {
    (summary as HTMLElement).style.display = 'block';
  });
}

/**
 * Capture the CURRENT VIEWPORT.
 *
 * Viewport, not full page, on purpose: what the reporter is looking at is what they
 * are reporting, a full-page render multiplies the payload, and sticky/fixed elements
 * render badly when the capture is taller than the window.
 *
 * THE EXCLUSION CONTRACT: anything that must not appear in the shot carries
 * REDACT_ATTRIBUTE — both renderers drop those subtrees. That attribute, NOT
 * call ordering, is what keeps the report dialog out of the screenshot: the dialog
 * (panel and overlay both marked) opens in the same tick as the capture starts,
 * because a full-page render measures in SECONDS (~1.5-4.5s at ~2000 elements) and
 * holding the dialog for it made the button read as frozen. Two shipped mistakes
 * inform this design: v1 opened the dialog unredacted before capturing (the form was
 * in every screenshot); v2 awaited the capture before opening (correct pixels, 5-8s
 * of dead air). Anything new that must never be captured — a future shake-to-report
 * toast, a debug panel — gets the attribute, not a sequencing rule.
 *
 * Returns null on any failure. A missing screenshot degrades the report; a thrown
 * error would lose it entirely, and the reporter's text is the part that cannot be
 * re-derived.
 */
export async function captureViewport(options: CaptureOptions = {}): Promise<CaptureResult | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const attribute = options.redactAttribute ?? REDACT_ATTRIBUTE;

  // Preferred first, fallback second — chosen by OUTCOME (threw, or produced something
  // blank/tainted), never by sniffing the user agent.
  let rendered: HTMLCanvasElement | null = null;
  for (const render of [renderWithModernScreenshot, renderWithHtml2Canvas]) {
    try {
      const candidate = await render(attribute);
      if (candidate && looksUsable(candidate)) {
        rendered = candidate;
        break;
      }
    } catch {
      // Try the next renderer. Both failing is handled below.
    }
  }
  if (!rendered) return null;

  try {
    const canvas = downscale(rendered, options.maxEdge ?? MAX_EDGE_PX);
    const blob = await encodeWithinBudget(canvas, options.targetBytes ?? TARGET_MAX_BYTES);
    if (!blob || blob.size > (options.hardMaxBytes ?? HARD_MAX_BYTES)) return null;
    return { blob, width: canvas.width, height: canvas.height };
  } catch {
    // Encoding failed (out of memory on a huge page). The report still goes, without
    // a screenshot — the reporter's text is what cannot be re-derived.
    return null;
  }
}
