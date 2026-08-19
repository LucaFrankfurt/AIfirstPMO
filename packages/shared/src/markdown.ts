/**
 * A small, safe markdown renderer.
 *
 * Everything is HTML-escaped before any markup is generated, and only a fixed
 * set of tags is ever produced — so user content cannot inject scripts, and we
 * avoid shipping a parser plus a sanitiser for what pages and comments need.
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
export interface MarkdownRefs {
  /** Project keys, as written in an identifier: `['WEB', 'APP']`. */
  keys?: readonly string[];
  /** Where a project lives, by key. Without this `#WEB` stays plain text. */
  projectHref?: (key: string) => string | undefined;
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
function references(html: string, refs: MarkdownRefs): string {
  const keys = (refs.keys ?? []).filter((key) => KEY_SHAPE.test(key));
  if (!keys.length) return html;
  const known = new Set(keys);

  const links: string[] = [];
  // Anchors whole, and images too: an upload called `/x?id=WEB-42.png` is a URL,
  // not a reference, and rewriting inside an attribute produces neither.
  let out = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<img\b[^>]*>/g, (match) => {
    links.push(match);
    return `\uE001${links.length - 1}\uE001`;
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

  return out.replace(/\uE001(\d+)\uE001/g, (_, index: string) => links[Number(index)]);
}

function inline(text: string, refs?: MarkdownRefs): string {
  let out = escapeHtml(text);

  // code spans first: their content must not be touched by later rules
  const codes: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE000`;
  });

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt: string, src: string) => {
    const url = safeUrl(src);
    return url ? `<img src="${url}" alt="${alt}" loading="lazy" />` : match;
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label: string, href: string) => {
    const url = safeUrl(href);
    if (!url) return match;
    const external = /^https?:/i.test(url);
    return `<a href="${url}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
  });

  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // References before the tag rule: `#WEB` is a project when the key is known,
  // and only a tag when it is not.
  if (refs) out = references(out, refs);
  out = out.replace(/(^|\s)(#[a-z0-9][\w-]*)/gi, '$1<span class="md-tag">$2</span>');

  return out.replace(/\uE000(\d+)\uE000/g, (_, index: string) => `<code>${codes[Number(index)]}</code>`);
}

interface ListContext {
  ordered: boolean;
  indent: number;
}

export function renderMarkdown(source: string, refs?: MarkdownRefs): string {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html: string[] = [];
  const lists: ListContext[] = [];
  let paragraph: string[] = [];
  let inCode = false;
  let codeLanguage = '';
  let codeLines: string[] = [];
  let inQuote = false;

  const closeParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inline(paragraph.join(' '), refs)}</p>`);
      paragraph = [];
    }
  };
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1].indent > toIndent) {
      html.push(lists.pop()!.ordered ? '</ol>' : '</ul>');
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      html.push('</blockquote>');
      inQuote = false;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '    ');

    if (inCode) {
      if (/^\s*```/.test(line)) {
        html.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ''}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = /^\s*```(\w+)?/.exec(line);
    if (fence) {
      closeParagraph();
      closeLists();
      closeQuote();
      inCode = true;
      codeLanguage = fence[1] ?? '';
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      closeLists();
      closeQuote();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeParagraph();
      closeLists();
      closeQuote();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2], refs)}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      closeParagraph();
      closeLists();
      closeQuote();
      html.push('<hr />');
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeParagraph();
      closeLists();
      if (!inQuote) {
        html.push('<blockquote>');
        inQuote = true;
      }
      html.push(`<p>${inline(quote[1], refs)}</p>`);
      continue;
    }
    closeQuote();

    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      closeParagraph();
      const indent = item[1].length;
      const ordered = /\d/.test(item[2]);
      closeLists(indent);
      const top = lists[lists.length - 1];
      if (!top || top.indent < indent) {
        lists.push({ ordered, indent });
        html.push(ordered ? '<ol>' : '<ul>');
      }
      const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
      if (checkbox) {
        const checked = checkbox[1].toLowerCase() === 'x';
        html.push(
          `<li class="md-task"><input type="checkbox" disabled${checked ? ' checked' : ''} /><span${checked ? ' class="md-done"' : ''}>${inline(checkbox[2], refs)}</span></li>`,
        );
      } else {
        html.push(`<li>${inline(item[3], refs)}</li>`);
      }
      continue;
    }
    closeLists();

    if (line.includes('|') && /\|.*\|/.test(line)) {
      paragraph.push(line);
      continue;
    }

    paragraph.push(line.trim());
  }

  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  closeParagraph();
  closeLists();
  closeQuote();
  return html.join('\n');
}

/** First meaningful line, for previews and list rows. */
export function excerpt(source: string, max = 140): string {
  const text = String(source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
