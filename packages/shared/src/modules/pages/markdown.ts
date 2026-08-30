/**
 * A small, safe markdown renderer.
 *
 * Everything is HTML-escaped before any markup is generated, and only a fixed
 * set of tags is ever produced — so user content cannot inject scripts, and we
 * avoid shipping a parser plus a sanitiser for what pages and comments need.
 *
 * It is not CommonMark and does not try to be. Two omissions are deliberate
 * rather than unfinished. Raw HTML never survives, which is the whole point of
 * escaping first. And four-space indented code is not a code block, because
 * `toggleTask` counts checkboxes over the same source and cannot tell indented
 * code from a nested list without becoming a second parser — fences do that
 * job, and the editor's toolbar writes fences.
 */

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Only same-origin uploads and plain web links survive. */
function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (url.startsWith('#')) return url;
  return null;
}

/**
 * What this workspace's work is called, so a reference can be recognised.
 *
 * Deliberately *not* a pattern like `[A-Z]+-\d+` on its own: that also matches
 * `UTF-8`, `COVID-19` and `ISO-8601`, and a chat line about a standard should
 * not sprout a broken link to a task nobody has. The caller knows which project
 * keys exist, so it says; with no keys given nothing is linked, which is what
 * the server wants when it renders a shared page for a reader who has no
 * workspace to link into.
 */
export interface MarkdownOptions {
  /** Project keys, as written in an identifier: `['WEB', 'APP']`. */
  keys?: readonly string[];
  /** Where a project lives, by key. Without this `#WEB` stays plain text. */
  projectHref?: (key: string) => string | undefined;
  /**
   * Whether a checkbox can be ticked where it is rendered.
   *
   * Off by default, and that is the safe way round: an enabled checkbox with
   * nothing listening toggles on screen and then silently disagrees with the
   * text it came from. Switched on, each box carries its index — counted top to
   * bottom, skipping fenced code — and `toggleTask` in `editor.ts` counts the
   * same way, which is what keeps a click and a line of markdown pointing at
   * each other.
   */
  interactiveTasks?: boolean;
}


const KEY_SHAPE = /^[A-Z][A-Z0-9]{0,9}$/;

/**
 * Turn `WEB-42` into a link to that task, and `#WEB` into a link to that
 * project.
 *
 * Anchors that already exist are stashed first. Without that, a URL ending in
 * something identifier-shaped would grow a second anchor inside the first, and
 * a nested `<a>` is a link that swallows the one around it.
 */
function references(html: string, refs: MarkdownOptions): string {
  const keys = (refs.keys ?? []).filter((key) => KEY_SHAPE.test(key));
  if (!keys.length) return html;
  const known = new Set(keys);

  const links: string[] = [];
  // Anchors whole, and images too: an upload called `/x?id=WEB-42.png` is a URL,
  // not a reference, and rewriting inside an attribute produces neither.
  let out = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<img\b[^>]*>/g, (match) => {
    links.push(match);
    return `${links.length - 1}`;
  });

  out = out.replace(/(^|[^\w/-])([A-Z][A-Z0-9]{0,9})-(\d{1,6})\b/g, (match, before: string, key: string, number: string) => {
    if (!known.has(key)) return match;
    return `${before}<a class="md-ref" href="/t/${key}-${number}">${key}-${number}</a>`;
  });

  if (refs.projectHref) {
    out = out.replace(/(^|[^\w#])#([A-Z][A-Z0-9]{0,9})\b/g, (match, before: string, key: string) => {
      const href = known.has(key) ? refs.projectHref!(key) : undefined;
      return href ? `${before}<a class="md-ref" href="${href}">#${key}</a>` : match;
    });
  }

  return out.replace(/(\d+)/g, (_, index: string) => links[Number(index)]);
}

/**
 * A line break inside a paragraph, held as a placeholder until the end.
 *
 * Markdown has two ways of asking for one — a line ending in two spaces, and a
 * line ending in a backslash — and both are noticed before the emphasis rules
 * run. `<br />` written straight out would be text those rules can see, and a
 * paragraph is matched as one string so that emphasis opened on one line can
 * close on the next. The character is private-use, so nothing typed collides.
 */
const BREAK = '';

function inline(text: string, refs?: MarkdownOptions): string {
  let out = escapeHtml(text);

  // code spans first: their content must not be touched by later rules
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `${codes.length - 1}`;
  });

  // ...and after that stash, so a line of code that happens to end in a
  // backslash is code rather than a request for a line break.
  out = out.replace(/(?: {2,}|\\)\n/g, BREAK);

  // The optional title is written `&quot;…&quot;` and not `"…"` because the
  // whole string was escaped on the way in, several rules above. Spelled with a
  // literal quote — which is how it read for a long time — the group simply
  // never matched, and a link or an image carrying a title did not lose its
  // title: it stopped being a link at all and came out as the source text.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;(?:(?!&quot;).)*&quot;)?\)/g, (match, alt: string, src: string) => {
    const url = safeUrl(src);
    return url ? `<img src="${url}" alt="${alt}" loading="lazy" />` : match;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;(?:(?!&quot;).)*&quot;)?\)/g, (match, label: string, href: string) => {
    const url = safeUrl(href);
    if (!url) return match;
    const external = /^https?:/i.test(url);
    return `<a href="${url}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  });

  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  // Bold before italic, and both spelled so the other may sit inside them: the
  // old `[^*]+` could not cross the `*` in `**bold *and* italic**`, so a reader
  // got the asterisks instead of the emphasis. A lone `*` is ordinary text to
  // the bold rule, and the lazy quantifier keeps `**a** and **b**` two pairs
  // rather than one long one.
  out = out.replace(/\*\*((?:[^*]|\*(?!\*))+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\W)__((?:[^_]|_(?!_))+?)__(?=\W|$)/g, '$1<strong>$2</strong>');
  out = out.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // References before the tag rule: `#WEB` is a project when the key is known,
  // and only a tag when it is not.
  if (refs) out = references(out, refs);
  out = out.replace(/(^|\s)(#[a-z0-9][\w-]*)/gi, '$1<span class="md-tag">$2</span>');

  return out
    .replace(/(\d+)/g, (_, index: string) => `<code>${codes[Number(index)]}</code>`)
    .replace(new RegExp(BREAK, 'g'), '<br />');
}

/**
 * A paragraph's worth of lines, as one run of inline markup.
 *
 * Joined before rendering rather than after, so emphasis that opens on one line
 * and closes on the next still reads as emphasis. The newlines survive into
 * `inline`, which is where the ones the author asked to keep become breaks;
 * what is left is a soft wrap, and a soft wrap is a space.
 */
function inlineBlock(lines: string[], refs?: MarkdownOptions): string {
  return inline(lines.join('\n'), refs).replace(/\n/g, ' ');
}

/* ----------------------------------------------------------------- tables */

const DELIMITER = /^:?-+:?$/;

/**
 * The cells of one table line.
 *
 * The pipes that bracket a row are decoration and come off; a `\|` is a pipe
 * somebody wanted to write and stays one. Splitting happens before any inline
 * rule runs, which is why `` `a | b` `` is two cells and not one — that is what
 * GitHub does with it too, and matching the tool people learned this in is
 * worth more here than being clever.
 */
function row(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (/(^|[^\\])\|$/.test(text)) text = text.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
      continue;
    }
    if (text[i] === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += text[i];
  }
  cells.push(cell);
  return cells.map((one) => one.trim());
}

/**
 * The `| --- | :-: |` line under a header, and what each column aligns to.
 *
 * A pipe is required, which is what keeps this from arguing with the other two
 * things a row of dashes can mean: `---` on its own stays a rule, and `---`
 * under a line of prose stays that line's underline.
 */
function alignments(line: string): (string | null)[] | null {
  if (!line.includes('|')) return null;
  const cells = row(line);
  if (!cells.length || !cells.every((cell) => DELIMITER.test(cell))) return null;
  return cells.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

/**
 * Alignment rides on the cell as a style rather than a class, because this
 * markup is read by two stylesheets — the app's and the small inline one a
 * shared page carries — and a style needs neither of them to agree. The values
 * come from a fixed set three lines above, so there is nothing here to inject
 * into.
 */
function table(header: string[], align: (string | null)[], body: string[][], refs?: MarkdownOptions): string {
  const cell = (tag: 'th' | 'td', text: string, at: number): string =>
    `<${tag}${align[at] ? ` style="text-align:${align[at]}"` : ''}>${inline(text, refs)}</${tag}>`;

  return [
    '<table>',
    `<thead><tr>${header.map((text, at) => cell('th', text, at)).join('')}</tr></thead>`,
    ...(body.length
      ? ['<tbody>', ...body.map((cells) => `<tr>${cells.map((text, at) => cell('td', text, at)).join('')}</tr>`), '</tbody>']
      : []),
    '</table>',
  ].join('\n');
}

/* ------------------------------------------------------------------ blocks */

interface ListLevel {
  ordered: boolean;
  indent: number;
  /**
   * Whether this level still has an `<li>` open.
   *
   * A nested list belongs *inside* the item it hangs off, so an item cannot be
   * closed when it is written — only when the next one at that depth arrives,
   * or when the level itself ends. The old renderer closed each `<li>` at once
   * and put the nested `<ul>` between two items, which is markup no browser
   * indents the way the author meant.
   */
  open: boolean;
}

/** How many checkboxes have been drawn, shared across one whole render. */
interface TaskCount {
  n: number;
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`]*)$/;
const FENCE_END = /^\s*(`{3,}|~{3,})\s*$/;

/**
 * A fenced block. A `mermaid` fence keeps its source as readable code and takes
 * a class: the app swaps in a drawn diagram, and anywhere without that — a
 * shared page carries no script on purpose — the reader still gets the text.
 */
function code(source: string, language: string): string {
  return `<pre${language === 'mermaid' ? ' class="md-mermaid"' : ''}>`
    + `<code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(source)}</code></pre>`;
}

export function renderMarkdown(source: string, refs?: MarkdownOptions): string {
  return blocks(String(source ?? '').replace(/\r\n?/g, '\n').split('\n'), refs, { n: 0 });
}

/**
 * One level of block structure.
 *
 * Takes lines rather than a string because it calls itself for the inside of a
 * blockquote. A quote can hold a list, a fence, a table or another quote, and
 * recursing is cheaper — and far less wrong — than teaching every rule below
 * how to see past a `>`.
 *
 * `tasks` is null in there. `toggleTask` rewrites the source by counting
 * checkboxes from the top and its pattern cannot see one behind a `>`, so a
 * checkbox inside a quote is drawn inert and counted by neither. That is what
 * keeps a click and a line of markdown pointing at the same box.
 */
function blocks(lines: string[], refs: MarkdownOptions | undefined, tasks: TaskCount | null): string {
  const html: string[] = [];
  const lists: ListLevel[] = [];
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineBlock(paragraph, refs)}</p>`);
    paragraph = [];
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      const level = lists.pop()!;
      if (level.open) html.push('</li>');
      html.push(level.ordered ? '</ol>' : '</ul>');
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\t/g, '    ');

    const fence = FENCE.exec(line);
    if (fence) {
      closeParagraph();
      closeLists();
      const [, indent, mark, info] = fence;
      const body: string[] = [];
      let end = index + 1;
      for (; end < lines.length; end++) {
        const close = FENCE_END.exec(lines[end].replace(/\t/g, '    '));
        // A fence closes on its own marker, and on one at least as long as the
        // one that opened it — which is how a block of markdown containing
        // ``` is written with ````.
        if (close && close[1][0] === mark[0] && close[1].length >= mark.length) break;
        // The opening indent comes off every line, so a fence inside a list
        // does not arrive with the list's indentation baked into the code.
        body.push(lines[end].startsWith(indent) ? lines[end].slice(indent.length) : lines[end]);
      }
      // Past the closing fence, or past the end when the author never wrote one.
      index = end;
      html.push(code(body.join('\n'), info.trim().split(/\s+/)[0] ?? ''));
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      closeLists();
      continue;
    }

    // A table announces itself on its second line, so it is recognised from the
    // header with the delimiter in hand. GFM lets one interrupt a paragraph,
    // which is why this sits above everything that would swallow the line.
    const align = index + 1 < lines.length ? alignments(lines[index + 1]) : null;
    const header = align && line.includes('|') ? row(line) : [];
    if (align && header.length === align.length) {
      closeParagraph();
      closeLists();
      const body: string[][] = [];
      let end = index + 2;
      for (; end < lines.length && lines[end].trim() && lines[end].includes('|'); end++) {
        const cells = row(lines[end]);
        // A short row is padded out and a long one loses the extra, so every
        // row has the shape the header promised.
        body.push(Array.from({ length: header.length }, (_, at) => cells[at] ?? ''));
      }
      index = end - 1;
      html.push(table(header, align, body, refs));
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      closeParagraph();
      closeLists();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2], refs)}</h${level}>`);
      continue;
    }

    // A row of `=` or `-` underlining a paragraph is that paragraph's heading.
    // Above the rule below on purpose: `---` under prose is a heading and `---`
    // on its own is a rule, and every markdown people have used agrees.
    const underline = /^ {0,3}(=+|-+)\s*$/.exec(line);
    if (underline && paragraph.length && !lists.length) {
      const level = underline[1][0] === '=' ? 1 : 2;
      html.push(`<h${level}>${inlineBlock(paragraph, refs)}</h${level}>`);
      paragraph = [];
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeParagraph();
      closeLists();
      html.push('<hr />');
      continue;
    }

    if (/^\s*>/.test(line)) {
      closeParagraph();
      closeLists();
      const inner: string[] = [];
      let end = index;
      for (; end < lines.length; end++) {
        const quoted = /^\s*>\s?(.*)$/.exec(lines[end]);
        if (!quoted) break;
        inner.push(quoted[1]);
      }
      index = end - 1;
      html.push(`<blockquote>\n${blocks(inner, refs, null)}\n</blockquote>`);
      continue;
    }

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      closeParagraph();
      const indent = item[1].length;
      const ordered = /\d/.test(item[2]);
      closeLists(indent);
      let top = lists[lists.length - 1];
      // A bullet where a number was, at the same depth, is a different list and
      // not a stray item in this one.
      if (top && top.indent === indent && top.ordered !== ordered) {
        closeLists(indent - 1);
        top = lists[lists.length - 1];
      }
      if (!top || top.indent < indent) {
        const start = ordered ? parseInt(item[2], 10) : 1;
        html.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>` : '<ul>');
        lists.push({ ordered, indent, open: false });
        top = lists[lists.length - 1];
      }
      // The previous item at this depth was left open in case something nested
      // under it. Nothing did, so it closes here.
      if (top.open) html.push('</li>');
      top.open = true;

      const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      if (checkbox) {
        const checked = checkbox[1].toLowerCase() === 'x';
        // Counted here rather than anywhere else, because this is the one place
        // that has already skipped fenced code — which is exactly the counting
        // `toggleTask` repeats over the source.
        const at = tasks ? tasks.n++ : -1;
        const box = at >= 0
          ? `<input type="checkbox" data-task="${at}"${refs?.interactiveTasks ? '' : ' disabled'}${checked ? ' checked' : ''} />`
          : `<input type="checkbox" disabled${checked ? ' checked' : ''} />`;
        html.push(`<li class="md-task">${box}<span${checked ? ' class="md-done"' : ''}>${inline(checkbox[2], refs)}</span>`);
      } else {
        html.push(`<li>${inline(item[3], refs)}`);
      }
      continue;
    }
    closeLists();

    // Trailing spaces survive: two of them are how a line asks for a break, and
    // trimming both ends here is what used to throw that away.
    paragraph.push(line.replace(/^\s+/, ''));
  }

  closeParagraph();
  closeLists();
  return html.join('\n');
}

/** First meaningful line, for previews and list rows. */
export function excerpt(source: string, max = 140): string {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
