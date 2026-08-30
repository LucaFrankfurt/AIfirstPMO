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
