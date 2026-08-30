import type { ReactNode } from 'react';
import { LOCALE_NAMES, localeLabel, useI18n, type Locale } from '../i18n/i18n';
import { Icon } from '../design-system/ui';
import { Select } from '../design-system/ui/field';

/**
 * The screen somebody sees before they have an account.
 *
 * Two panels: what this is on the left, and the form on the right. It is the
 * one screen in the app a stranger sees, and until now it said what it was in
 * a 12.5px line under the logo — which is to say it did not.
 *
 * **The left panel breaks a rule this project otherwise holds to**, so it is
 * written down rather than left to be discovered. `docs/design.md` says colour
 * means status, and a colour spent on chrome is one that no longer means
 * anything when it turns up on an overdue task. Half a screen of accent is
 * exactly that. It is deliberate and it is confined here: this panel never
 * renders beside a task, a board or a list, so nothing it could be confused
 * with is ever on screen at the same time. Anywhere past the sign-in form, the
 * rule stands.
 *
 * The panel is the same in both themes on purpose. It is a brand surface
 * rather than a themed one, and a dark-mode version would be a second design
 * to keep true rather than the same one seen twice.
 *
 * **No container queries here.** The three helpers — `hide-sm`, `only-sm`,
 * `not-sm` — measure `.main`, and this screen renders outside `AppShell`, so
 * there is no `.main` above it. A container query with no container never
 * matches, which would not make the panel compact; it would make it vanish. The
 * collapse below is a plain media query for that reason.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();

  return (
    <main className="auth">
      <aside className="auth-brand">
        <div className="auth-mark">
          <img src="/icon.svg" width={30} height={30} alt="" />
          <strong>Kolibri</strong>
        </div>

        <div>
          <h2>{t('auth.headline')}</h2>
          <p>{t('auth.blurb')}</p>
          <ul className="auth-facts">
            {(['auth.factOffline', 'auth.factPrivate', 'auth.factAssistant'] as const).map((key) => (
              <li key={key}>
                <Icon name="check" size={15} />
                {t(key)}
              </li>
            ))}
          </ul>
        </div>

        <span className="auth-licence">{t('auth.licence')}</span>
      </aside>

      <section className="auth-pane">
        <div className="auth-form">
          {/* The mark again, and only where the panel beside it is not there to
              carry it — a stranger on a phone would otherwise meet a form with
              no name on it. */}
          <img className="auth-mark-sm" src="/icon.svg" width={32} height={32} alt="" />
          {children}

          <div className="auth-footer">
            <Icon name="bolt" size={13} />
            <span className="whitespace-nowrap">{t('login.footer')}</span>
            <span aria-hidden="true">·</span>
            {/* Utilities rather than a class in `app.css`: `Select` ships its own
                — `w-full`, a border, `h-8` — and those sit in `@layer
                utilities`, which beats every hand-written rule no matter how
                specific. Passed through `className` they go through `twMerge`
                instead, where the later one simply wins. Written the other way
                first, and the language picker came out full width with a box
                around it, in a line of running text. */}
            <Select
              inputSize="sm"
              className="w-auto h-auto border-none bg-transparent px-1 py-0.5 text-[12.5px] text-muted"
              aria-label={t('auth.language')}
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
            >
              {(Object.keys(LOCALE_NAMES) as Locale[]).map((value) => (
                <option key={value} value={value}>{localeLabel(value)}</option>
              ))}
            </Select>
          </div>
        </div>
      </section>
    </main>
  );
}
