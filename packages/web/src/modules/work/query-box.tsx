/**
 * The filter, as text — in the box the search screen uses.
 *
 * This was a button that opened a sheet with a `<textarea>` in it, and it
 * understood a language the search box did not: `assignee = me` here, `@anna`
 * there, each one plain text to the other. Two inputs, both carrying a
 * magnifier, neither accepting the other's spelling. Now there is one box
 * (`kernel/search/search-box`) and one reading of a line
 * (`readQuery`), so a sentence means the same thing wherever it is typed —
 * the difference is only what each screen then does with it: this one narrows
 * the list underneath, the search screen goes and finds things.
 *
 * **Two views of one thing, still.** Whatever the menus do prints into this
 * field and whatever is typed here comes back out as the same menu state. That
 * is why the field is not empty — a query language you have to learn before it
 * shows you anything is one nobody learns.
 *
 * Errors are shown and the query is still applied. Half a filter is more useful
 * than none: the clauses that parsed take effect, and the sentence under the
 * field names the word to fix. What is never done is silently dropping a clause
 * — a filter that quietly widens is worse than one that matches nothing and
 * says so.
 *
 * On a phone the field becomes a button and the sheet comes back, which is the
 * same choice this header already makes for the four layout buttons: a text
 * field in a 52px row that scrolls sideways is a field you have to go looking
 * for. It is the same box inside, so the language does not change with the
 * width — only the furniture around it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { printQuery, hasUnprintable, type Filters } from '@kolibri/shared';
import { useT } from '../../kernel/i18n/i18n';
import { readQuery } from '../../kernel/search/search-query';
import { SearchBox, useFacetOptions, useVocabulary } from '../../kernel/search/search-box';
import { Button } from '../../kernel/design-system/ui/button';
import { Icon, Sheet } from '../../kernel/design-system/ui';

/** How long a line rests before it becomes the filter. */
const SETTLE_MS = 300;

export function QueryBox({
  filters, onChange, projectId,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
  projectId?: string;
}) {
  const t = useT();
  const options = useFacetOptions(projectId);
  const vocabulary = useVocabulary(projectId);

  const [text, setText] = useState(() => printQuery(filters, vocabulary));
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => readQuery(text, options, vocabulary), [text, options, vocabulary]);

  /**
   * The filter this field last asked for, so the menus can still write to it.
   *
   * Compared as printed text rather than as objects: `@Anna` and
   * `assignee = Anna` are the same filter and must not read as a change, or the
   * field would rewrite the reader's own sentence under their caret on every
   * keystroke. Printing both sides asks exactly the question that matters —
   * *do these two mean the same thing* — and `printQuery` is already the one
   * answer to it.
   */
  const asked = useRef(printQuery(filters, vocabulary));

  useEffect(() => {
    const incoming = printQuery(filters, vocabulary);
    if (incoming === asked.current) return;
    asked.current = incoming;
    setText(incoming);
  }, [filters, vocabulary]);

  /**
   * The caller, held rather than depended on.
   *
   * `onChange` is written as an arrow at the call site, so it is a different
   * function on every render of the screen — and a screen with a clock on it
   * renders often. As a dependency it restarted the timer below each time,
   * which means a filter typed on a busy screen would never have landed at
   * all. The timer must be restarted by the *text* changing and by nothing
   * else, so what the timer needs is read when it fires.
   */
  const latest = useRef({ onChange, field: filters.field });
  latest.current = { onChange, field: filters.field };

  useEffect(() => {
    const printed = printQuery(parsed.filters, vocabulary);
    if (printed === asked.current) return;
    const handle = setTimeout(() => {
      asked.current = printed;
      const { onChange: tell, field } = latest.current;
      // The custom-field part of a filter has no syntax yet, so it is carried
      // across untouched rather than thrown away by a field that cannot show
      // it — and only when there is one. `field: undefined` is not the same as
      // no `field` at all: the key is written, `Object.entries` reports it, and
      // the reader that expected an object got nothing. Every Apply on a filter
      // without a custom field in it took the screen down, which is to say
      // almost every Apply there has ever been.
      tell(field ? { ...parsed.filters, field } : parsed.filters);
    }, SETTLE_MS);
    return () => clearTimeout(handle);
  }, [parsed, vocabulary]);

  /** What the field says about itself: what is wrong, or what may be typed. */
  const hint = parsed.errors.length > 0 ? (
    <ul className="m-0 list-none p-1 text-[12.5px] text-danger">
      {parsed.errors.map((error) => (
        <li key={`${error.at}-${error.message}`} className="mb-1 flex items-start gap-1.5">
          <Icon name="bolt" size={13} />
          <span>{error.message}</span>
        </li>
      ))}
    </ul>
  ) : hasUnprintable(filters) ? (
    <p className="m-0 p-1.5 text-[12.5px] text-muted">{t('query.fieldsKept')}</p>
  ) : !text.trim() ? (
    <p className="m-0 p-1.5 text-[12.5px] text-muted">{t('query.hint')}</p>
  ) : null;

  /**
   * `loose` is also what decides where the hint goes. In the header it has to
   * hang out of a row 52px tall, so it is a panel; in the sheet there is room
   * under the field, and a panel there would simply float over the help text
   * that is already standing below it.
   */
  const box = (loose: boolean) => (
    <SearchBox
      value={text}
      onChange={setText}
      options={options}
      loose={loose}
      label={t('query.title')}
      placeholder={t('query.placeholder')}
      below={loose ? hint : undefined}
      autoFocus={!loose}
    />
  );

  return (
    <>
      {/* `not-sm`: the field stands in the header only where the header has
          room for it. Nothing inside the sheet below uses that utility or its
          two siblings — a sheet is portalled to `<body>`, out from under the
          `.main` container their query names, and a container query with no
          container does not turn compact, it disappears. */}
      {/* `flex: none`, and a width rather than a share of one. The header has a
          spacer in it that takes everything going, so a field that was allowed
          to shrink lost to it — 22px of room at 1020px and 0px at 780px, which
          `check:responsive` reported as three broken widths. This row scrolls
          sideways rather than squeezing its contents, by its own rule in
          `app.css`; a box you type into is exactly the kind of content that
          rule is for. */}
      <div className="not-sm" style={{ flex: 'none', width: 230 }}>
        {box(true)}
      </div>

      <Button
        className="only-sm" size="sm" onClick={() => setOpen(true)}
        title={t('query.title')} aria-label={t('query.title')}
      >
        <Icon name="search" size={14} />
      </Button>

      {open && (
        <Sheet
          title={t('query.title')}
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => setText('')}>{t('view.clearFilters')}</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>{t('query.apply')}</Button>
            </>
          }
        >
          {box(false)}
          {hint}
          <p className="mt-3 text-[12.5px] text-muted">{t('query.help')}</p>
          <pre className="md text-[12px] mt-1" style={{ background: 'var(--bg-sunken)', border: '1px solid var(--line)', padding: 10, borderRadius: 8, overflowX: 'auto' }}>
{`@Anna #Design is: open
assignee = me AND state != Done
priority in (urgent, high) AND due = overdue
project = WEB AND "design review" -entwurf`}
          </pre>
        </Sheet>
      )}
    </>
  );
}
