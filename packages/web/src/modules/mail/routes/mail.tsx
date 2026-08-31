/**
 * Reading four inboxes as one.
 *
 * Deliberately not a mail client. There is no compose, no reply, no folder
 * tree and no unread badge, because the server side is read-only by
 * construction — the IMAP session is opened with `EXAMINE` — and a screen that
 * offered a Reply button would be promising something the whole design refuses.
 *
 * What it is instead is the two questions a mail client cannot answer, next to
 * each other:
 *
 *   **Search** — one query across every connected mailbox, so "where did that
 *   invoice land" stops being three searches and a guess.
 *   **Documents** — the same corpus ranked by how likely each message is to
 *   carry something the accountant wants, with the reason shown. It ranks; the
 *   person decides, which is why the evidence is on screen rather than a score.
 *   **Numbers** — volume by mailbox and month, who writes most, how fast
 *   anybody answers.
 *
 * The same three are what MCP exposes, and that is on purpose: an assistant and
 * a person asking the same question should get the same answer, and the only
 * way to keep that true is for both to call the same endpoints.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Header } from '../../../kernel/design-system/chrome';
import { Empty, Icon, Sheet } from '../../../kernel/design-system/ui';
import { Button } from '../../../kernel/design-system/ui/button';
import { Input } from '../../../kernel/design-system/ui/field';
import { SectionHeading } from '../../../kernel/design-system/ui/section';
import { Chip } from '../../../kernel/design-system/ui/chip';
import { api } from '../../../kernel/sync/api';
import { useT } from '../../../kernel/i18n/i18n';
import { useSession } from '../../../kernel/identity/session';
import { useTabStrip } from '../../../kernel/design-system/tab-strip';

interface Hit {
  id: string;
  mailbox: string;
  subject: string;
  from_name: string;
  from_address: string;
  to_addresses: string[];
  sent_at: number;
  seen: number;
  has_attachments: number;
  snippet: string;
  thread_key: string;
}

interface Detail extends Hit {
  body: string;
  attachments: { id: string; filename: string; mime: string; size: number }[];
}

interface Ranked extends Hit {
  score: number;
  /** What the heuristic matched, in prose. Shown instead of the number. */
  why: string[];
  documents: string[];
  other_files: string[];
}

interface Stats {
  total: number;
  with_attachments: number;
  covers: { from: string | null; to: string | null };
  per_mailbox: { mailbox: string; total: number; unread: number; with_attachments: number }[];
  per_month: { month: string; total: number }[];
  top_senders: { address: string; name: string; count: number }[];
  response: { measurable: boolean; replies: number; median_minutes: number | null };
}

type Tab = 'search' | 'documents' | 'stats';

export function MailScreen() {
  const t = useT();
  const { workspaceId } = useSession();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('search');
  const strip = useTabStrip(tab);
  // The query lives in the URL, so a search anybody found useful is a link they
  // can send — the same reason the task query box puts its filter there.
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState<string[]>([]);
  const [open, setOpen] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const search = async (text: string) => {
    setLoading(true);
    setError('');
    try {
      const answer = await api.get<{ messages: Hit[]; total: number; searched: string[] }>(
        `/api/workspaces/${workspaceId}/mail?limit=50&q=${encodeURIComponent(text)}`,
      );
      setHits(answer.messages);
      setTotal(answer.total);
      setSearched(answer.searched);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void search(query); }, [workspaceId]);

  return (
    <>
      <Header title={t('mail.title')} />
      <div ref={strip} className="tabs tabs-inset">
        {(['search', 'documents', 'stats'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {t(name === 'search' ? 'mail.title' : name === 'documents' ? 'mail.documents' : 'mail.stats')}
          </button>
        ))}
      </div>

      <div className="mx-auto max-w-[1180px] px-3 pb-20 pt-4 sm:px-6 sm:pb-16 sm:pt-5">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setParams(query ? { q: query } : {}, { replace: true });
            void search(query);
          }}
        >
          <Input
            className="flex-1 min-w-0" aria-label={t('mail.title')}
            placeholder={t('mail.searchPlaceholder')}
            value={query} onChange={(event) => setQuery(event.target.value)}
          />
          <Button type="submit" disabled={loading}><Icon name="search" size={14} /></Button>
        </form>
        <p className="text-[12px] text-muted mt-1">{t('mail.searchHint')}</p>
        {error && <p className="text-[12px] text-danger">{error}</p>}

        {tab === 'search' && (
          <Results
            hits={hits} total={total} searched={searched} loading={loading}
            onOpen={async (id) => setOpen(await api.get<Detail>(`/api/workspaces/${workspaceId}/mail/${id}`))}
          />
        )}
        {tab === 'documents' && <Documents query={query} />}
        {tab === 'stats' && <Numbers query={query} />}
      </div>

      {open && <Message message={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Results({ hits, total, searched, loading, onOpen }: {
  hits: Hit[];
  total: number;
  searched: string[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  if (loading) return <div className="skeleton mt-3" style={{ height: 10 }} />;
  if (!hits.length) return <Empty title={t('mail.results', { count: 0 })} />;
  return (
    <>
      <p className="text-[12px] text-muted mt-3">
        {t('mail.results', { count: total })} · {t('mail.searched', { mailboxes: searched.join(', ') })}
      </p>
      {hits.map((hit) => (
        <button key={hit.id} className="w-full text-left rounded-[var(--radius)] border border-line bg-raised p-2 mb-2" onClick={() => onOpen(hit.id)}>
          <div className="flex items-center gap-2">
            <span className="flex-1 min-w-0 truncate">{hit.subject || '—'}</span>
            {!!hit.has_attachments && <Icon name="attach" size={13} />}
            <Chip>{hit.mailbox}</Chip>
          </div>
          <div className="text-[12px] text-muted truncate">
            {hit.from_name || hit.from_address} · {new Date(hit.sent_at).toISOString().slice(0, 10)}
          </div>
          <div className="text-[12px] text-muted truncate">{hit.snippet}</div>
        </button>
      ))}
    </>
  );
}

/**
 * The document hunt, on screen.
 *
 * It calls the same search the assistant's `find_documents` does and shows the
 * same evidence — because the number on its own is not a reason, and a list
 * that says "score 14" is a list somebody either trusts blindly or ignores.
 */
function Documents({ query }: { query: string }) {
  const t = useT();
  const { workspaceId } = useSession();
  const [rows, setRows] = useState<Ranked[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get<{ candidates: Ranked[] }>(
      `/api/workspaces/${workspaceId}/mail-documents?limit=50&q=${encodeURIComponent(query)}`,
    )
      .then((answer) => setRows(answer.candidates))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [workspaceId, query]);

  if (loading) return <div className="skeleton mt-3" style={{ height: 10 }} />;
  if (!rows.length) return <Empty title={t('mail.results', { count: 0 })} />;
  return (
    <>
      <p className="text-[12px] text-muted mt-3">{t('mail.documentsHint')}</p>
      {rows.map((row) => (
        <div key={row.id} className="rounded-[var(--radius)] border border-line bg-raised p-2 mb-2">
          <div className="flex items-center gap-2">
            <span className="flex-1 min-w-0 truncate">{row.subject || '—'}</span>
            <Chip>{row.mailbox}</Chip>
          </div>
          <div className="text-[12px] text-muted truncate">
            {row.from_name || row.from_address} · {new Date(row.sent_at).toISOString().slice(0, 10)}
          </div>
          {/* The reason, not the score. A list that says "14" is one somebody
              either trusts blindly or ignores; "invoice in the filename" is one
              they can disagree with. */}
          <div className="flex flex-wrap gap-1 mt-1">
            {row.documents.map((file) => <Chip key={file} tone="on">{file}</Chip>)}
            {row.why.slice(0, 4).map((reason) => <Chip key={reason}>{reason}</Chip>)}
          </div>
        </div>
      ))}
    </>
  );
}

function Numbers({ query }: { query: string }) {
  const t = useT();
  const { workspaceId } = useSession();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.get<Stats>(`/api/workspaces/${workspaceId}/mail-stats?q=${encodeURIComponent(query)}`)
      .then(setStats)
      .catch(() => setStats(null));
  }, [workspaceId, query]);

  if (!stats) return <div className="skeleton mt-3" style={{ height: 10 }} />;
  const peak = Math.max(1, ...stats.per_month.map((one) => one.total));
  return (
    <>
      <p className="text-[12px] text-muted mt-3">
        {t('mail.results', { count: stats.total })}
        {stats.covers.from && ` · ${t('mail.coverage', { from: stats.covers.from, to: stats.covers.to ?? '' })}`}
      </p>

      <SectionHeading>{t('mail.perMonth')}</SectionHeading>
      {stats.per_month.map((month) => (
        <div key={month.month} className="flex items-center gap-2 text-[12px]">
          <span style={{ width: 64 }}>{month.month}</span>
          {/* A bar rather than a chart library: one number per row, and the
              width is the whole story. */}
          <span className="rounded bg-accent-soft" style={{ width: `${(month.total / peak) * 60}%`, height: 8 }} />
          <span className="text-muted">{month.total}</span>
        </div>
      ))}

      <SectionHeading>{t('mail.topSenders')}</SectionHeading>
      {stats.top_senders.slice(0, 12).map((sender) => (
        <div key={sender.address} className="flex items-center gap-2 text-[12px]">
          <span className="flex-1 min-w-0 truncate">{sender.name || sender.address}</span>
          <span className="text-muted">{sender.count}</span>
        </div>
      ))}

      <SectionHeading>{t('mail.response')}</SectionHeading>
      <p className="text-[12px] text-muted">
        {stats.response.measurable
          ? t('mail.minutes', { count: stats.response.median_minutes ?? 0 })
          : t('mail.responseUnmeasurable')}
      </p>
    </>
  );
}

function Message({ message, onClose }: { message: Detail; onClose: () => void }) {
  const t = useT();
  return (
    <Sheet onClose={onClose} title={message.subject || '—'}>
      <div className="text-[12px] text-muted">
        {message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}
        {' · '}{new Date(message.sent_at).toISOString().slice(0, 16).replace('T', ' ')}
        {' · '}{message.mailbox}
      </div>
      {!!message.attachments.length && (
        <div className="flex flex-wrap gap-1 mt-2">
          {message.attachments.map((file) => (
            <Chip key={file.id}><Icon name="attach" size={12} /> {file.filename}</Chip>
          ))}
        </div>
      )}
      {/* Plain text in a `pre`, never rendered as HTML. These bytes came from a
          stranger's mail server; the fetcher already flattened any HTML part to
          text, and rendering it here would undo that in the one place where the
          origin is this app's own. */}
      <pre className="whitespace-pre-wrap text-[13px] mt-3">{message.body}</pre>
      <p className="text-[12px] text-muted">{t('mail.thread')}</p>
    </Sheet>
  );
}
