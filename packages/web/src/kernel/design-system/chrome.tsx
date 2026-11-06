/**
 * The frame's furniture: the page header, the sync pill in it, and the theme.
 *
 * These were in `AppShell.tsx` with the shell itself, which meant the file that
 * every route imports `Header` from also imported QuickAdd, the refile menu and
 * the unread count — three capabilities, pulled into the design system by
 * neighbourhood. The frame is the shell's now (`src/AppShell.tsx`) and this is
 * what was actually shared.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { duration } from '@kolibri/shared';
import { dismissRejected, pull, subscribeSync, type RejectedChange, type SyncStatus } from '../sync/sync';
import { clockOffset, NOTICEABLE } from '../sync/clock';
import { currentLocale, useT, type TranslationKey } from '../i18n/i18n';
import { chipDot } from './ui/chip';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useMinute } from './minute';
import { Icon } from './ui';

/* ------------------------------------------------------------ sync status */

function SyncPill() {
  const t = useT();
  const [status, setStatus] = useState<SyncStatus>({ state: 'starting', pending: 0, lastSyncedAt: null, rejected: [] });
  useEffect(() => subscribeSync(setStatus), []);
  useMinute(); // so a reading that lands after this rendered still reaches the tooltip

  /*
   * What the two clocks disagree by, where somebody can find it.
   *
   * The app is correct under a wrong clock now — every age is counted on the
   * server's — and that is exactly why this has to be said out loud somewhere:
   * a difference of five minutes used to be visible as nonsense under every
   * task, and silently correcting it would hide a machine that needs winding.
   * It belongs on this pill rather than in the instance settings because it is
   * a fact about *this device*, not about the server: the admin reading those
   * settings would see their own laptop's error presented as the instance's.
   */
  const drift = clockOffset();
  const clock = Math.abs(drift) >= NOTICEABLE
    // A negative offset is a server behind this device, which is to say a
    // device that is ahead — the sentence is written from the reader's side.
    ? t(drift < 0 ? 'sync.clockAhead' : 'sync.clockBehind', { amount: duration(Math.round(Math.abs(drift) / 60_000)) })
    : '';

  const refused = status.rejected;
  const label =
    refused.length ? t('sync.rejected', { count: refused.length })
    : status.state === 'offline'
      ? (status.pending ? t('sync.offlineQueued', { count: status.pending }) : t('sync.offline'))
      : status.state === 'error' ? t('sync.issue')
        : status.pending ? t('sync.syncing', { count: status.pending })
          : t('sync.synced');

  const icon = refused.length || status.state === 'error' ? 'alert'
    : status.state === 'offline' ? 'offline'
      : status.state === 'syncing' || status.pending ? 'refresh' : 'check';

  const pill = (
    <button
      className={`status-pill ${refused.length ? 'error' : status.state}`}
      onClick={refused.length ? undefined : () => void pull()}
      // The word beside the dot is `hide-sm`, so on a phone this button is an
      // icon and nothing else. The name has to come from somewhere.
      aria-label={refused.length ? label : `${label} — ${t('sync.now')}`}
      title={[
        refused.at(-1)?.reason ?? status.message ?? (status.lastSyncedAt
          ? t('sync.lastSynced', { time: new Date(status.lastSyncedAt).toLocaleTimeString(currentLocale()) })
          : t('sync.now')),
        clock,
      ].filter(Boolean).join('\n')}
    >
      {/* `dot` as well as the utilities: every colour this indicator has —
          green for synced, amber for offline, red for a failure, and the
          pulsing accent while it works — is keyed on `.status-pill .dot` in
          the stylesheet, and the class had been dropped. The dot was drawing
          nothing. On a desktop the word beside it covered for that; on a phone
          the word is hidden and the status was an empty circle. */}
      <span className={`dot not-sm ${chipDot}`} />
      {/* On a phone the word is hidden, so a shape stands in for the dot's colour (UX-10). */}
      <Icon name={icon} size={13} className="state-icon only-sm" />
      {status.pending > 0 && <span className="only-sm">{status.pending}</span>}
      <span className="hide-sm">{label}</span>
    </button>
  );
  if (!refused.length) return pill;

  // Refused changes stay listed, content included, until somebody copies or dismisses them.
  return (
    <Popover>
      <PopoverTrigger asChild>{pill}</PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[90vw] p-3 text-[13px]">
        <ul className="m-0 flex max-h-64 list-none flex-col gap-2 overflow-auto p-0">
          {refused.map((change) => (
            <li key={change.id} className="min-w-0">
              <div className="truncate">{preview(change)}</div>
              <div className="text-soft">{change.reason}</div>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(refused, null, 2))}>
            {t('action.copy')}
          </Button>
          <Button size="sm" onClick={() => void dismissRejected()}>{t('sync.dismissRejected')}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const preview = (change: RejectedChange): string => {
  const text = change.patch.title ?? change.patch.name ?? change.patch.content ?? change.patch.body;
  return `${change.entity}${typeof text === 'string' && text ? ` · ${text}` : ''}`;
};

/* ----------------------------------------------------------------- themes */

type Theme = 'system' | 'light' | 'dark';

function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('kolibri.theme', theme);
}

export const THEME_KEY: Record<Theme, TranslationKey> = {
  system: 'profile.themeSystem', light: 'profile.themeLight', dark: 'profile.themeDark',
};

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('kolibri.theme') as Theme) ?? 'system');
  useEffect(() => applyTheme(theme), [theme]);
  return [theme, setTheme];
}

/** One step on the way to here: where it goes, and what it is called. */
export interface Crumb {
  to: string;
  label: string;
  /** Drawn before the label and hidden from assistive tech: an emoji or an `Icon`. */
  icon?: React.ReactNode;
}

/**
 * Where you are, and therefore the way back out.
 *
 * Every detail screen in the app had the same hole: a project, a cycle, a
 * milestone, a KPI, a budget and a page could all be opened from a link, a
 * search result or a bookmark, and none of them said where it sat or offered a
 * route back to its list. The only way out was the sidebar — which on a phone
 * means opening the menu to leave a document. Six screens with the same gap is
 * one missing piece of furniture, not six oversights.
 *
 * Deliberately a trail rather than a back arrow. An arrow does one job and says
 * nothing; this does the same job and also answers "where am I", which is the
 * question somebody arriving from a search actually has. And it is real links,
 * so the keyboard reaches them and a middle click opens a tab.
 *
 * Drawn even when there is one crumb. A trail that appears only for nested
 * things is a trail nobody learns to look for.
 */
export function Trail({ parts }: { parts: Crumb[] }) {
  const t = useT();
  if (!parts.length) return null;
  return (
    <nav className="trail" aria-label={t('nav.trail')}>
      {parts.map((crumb, at) => (
        <span key={`${crumb.to}-${at}`} className="contents">
          {/* The separator is an element rather than a `content:` string,
              because a generated string is read out by some screen readers and
              nobody needs to hear "handbook slash onboarding". */}
          {at > 0 && <span className="sep" aria-hidden="true">/</span>}
          <Link to={crumb.to}>
            {crumb.icon && <span aria-hidden="true">{crumb.icon}</span>}
            <span className="truncate">{crumb.label}</span>
          </Link>
        </span>
      ))}
    </nav>
  );
}

/** Page header used by every route. */
export function Header({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="header">
      {/* `min-w-[72px]`, not `min-w-0`: the header scrolls sideways rather than
          squeezing, so a title that may shrink to nothing shrinks to nothing —
          which is what it did, leaving a screen with no name on it. */}
      <h1 className="flex-1 min-w-[72px] truncate">{title}</h1>
      {children}
      <SyncPill />
    </header>
  );
}
