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
import { pull, subscribeSync, type SyncStatus } from '../sync/sync';
import { currentLocale, useT, type TranslationKey } from '../i18n/i18n';
import { chipDot } from './ui/chip';

/* ------------------------------------------------------------ sync status */

function SyncPill() {
  const t = useT();
  const [status, setStatus] = useState<SyncStatus>({ state: 'starting', pending: 0, lastSyncedAt: null });
  useEffect(() => subscribeSync(setStatus), []);

  const label =
    status.state === 'offline'
      ? (status.pending ? t('sync.offlineQueued', { count: status.pending }) : t('sync.offline'))
      : status.state === 'error' ? t('sync.issue')
        : status.pending ? t('sync.syncing', { count: status.pending })
          : t('sync.synced');

  return (
    <button
      className={`status-pill ${status.state}`}
      onClick={() => void pull()}
      // The word beside the dot is `hide-sm`, so on a phone this button is a
      // coloured dot and nothing else. The name has to come from somewhere.
      aria-label={`${label} — ${t('sync.now')}`}
      title={status.message ?? (status.lastSyncedAt
        ? t('sync.lastSynced', { time: new Date(status.lastSyncedAt).toLocaleTimeString(currentLocale()) })
        : t('sync.now'))}
    >
      {/* `dot` as well as the utilities: every colour this indicator has —
          green for synced, amber for offline, red for a failure, and the
          pulsing accent while it works — is keyed on `.status-pill .dot` in
          the stylesheet, and the class had been dropped. The dot was drawing
          nothing. On a desktop the word beside it covered for that; on a phone
          the word is hidden and the status was an empty circle. */}
      <span className={`dot ${chipDot}`} />
      <span className="hide-sm">{label}</span>
    </button>
  );
}

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
