import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../session';
import { LOCALE_NAMES, localeLabel, useI18n, type Locale } from '../lib/i18n';
import { Icon } from '../components/ui';

export function Login() {
  const { t, locale, setLocale } = useI18n();
  const { signIn } = useSession();
  const navigate = useNavigate();
  const { code } = useParams();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [config, setConfig] = useState<
    { allowSignup: boolean; hasUsers: boolean; sso?: { label: string; only: boolean } | null } | null
  >(null);
  const [invite, setInvite] = useState<{ workspace_name: string } | null>(null);
  const [form, setForm] = useState({ email: '', password: '', name: '', workspace: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.config()
      .then((next) => {
        setConfig(next);
        // The very first visitor sets up the instance.
        if (!next.hasUsers) setMode('register');
      })
      .catch(() => setConfig({ allowSignup: true, hasUsers: true }));
  }, []);

  // The single sign-on round trip ends back here on failure, with something
  // readable in the URL rather than a bare error page in a tab you cannot
  // leave. Read it once, then clean the address bar so a reload is not an
  // error again.
  useEffect(() => {
    const failed = new URLSearchParams(window.location.search).get('sso_error');
    if (!failed) return;
    setError(failed);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (!code) return;
    api.get<any>(`/api/invites/${code}`)
      .then((next) => {
        setInvite(next);
        setMode('register');
      })
      .catch(() => setError(t('login.inviteInvalid')));
  }, [code, t]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const session = mode === 'login'
        ? await api.login(form.email, form.password)
        : await api.register({
          email: form.email,
          name: form.name || form.email.split('@')[0],
          password: form.password,
          workspace: form.workspace || undefined,
          invite: code,
        });
      if (code && mode === 'login') await api.acceptInvite(code);
      await signIn(session);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.somethingWentWrong'));
    } finally {
      setBusy(false);
    }
  }

  const first = config && !config.hasUsers;
  const sso = config?.sso ?? null;
  // Only a path on this instance is ever handed back — the server refuses
  // anything else, and there is no reason to send it something it will drop.
  const ssoHref = `/api/auth/oidc/start?next=${encodeURIComponent(code ? `/invite/${code}` : '/')}`;

  return (
    <div className="auth">
      <form className="box" onSubmit={submit}>
        <div className="row" style={{ marginBottom: 16 }}>
          <img src="/icon.svg" width={30} height={30} alt="" style={{ borderRadius: 8 }} />
          <div>
            <h1>{first ? t('login.setupTitle') : mode === 'login' ? t('login.welcomeBack') : t('login.createAccount')}</h1>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {invite
                ? t('login.invitedTo', { workspace: invite.workspace_name })
                : first ? t('login.firstAccountHint') : t('login.tagline')}
            </span>
          </div>
        </div>

        {error && <div className="error">{error}</div>}

        {sso && (
          <>
            <a className={`btn block lg ${sso.only ? 'primary' : ''}`} href={ssoHref}>
              <Icon name="shield" size={15} /> {t('login.ssoContinue', { provider: sso.label })}
            </a>
            {!sso.only && (
              <div className="divider-text" aria-hidden="true"><span>{t('login.ssoOr')}</span></div>
            )}
          </>
        )}

        {sso?.only && (
          <p className="muted" style={{ fontSize: 12.5, margin: '12px 0 0' }}>{t('login.ssoOnlyHint')}</p>
        )}

        {!sso?.only && (<>
        {mode === 'register' && (
          <div className="field">
            <label htmlFor="name">{t('login.yourName')}</label>
            <input id="name" className="input" value={form.name} autoComplete="name"
              onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">{t('login.email')}</label>
          <input
            id="email" className="input" type="email" required autoComplete="email" autoFocus={mode === 'login'}
            value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="password">{t('login.password')}</label>
          <input
            id="password" className="input" type="password" required minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
          {mode === 'register' && <span className="hint">{t('login.passwordHint')}</span>}
        </div>

        {mode === 'register' && !code && (
          <div className="field">
            <label htmlFor="workspace">{t('login.workspaceName')}</label>
            <input
              id="workspace" className="input" placeholder={t('login.workspacePlaceholder')} value={form.workspace}
              onChange={(event) => setForm({ ...form, workspace: event.target.value })}
            />
          </div>
        )}

        <button className="btn primary block lg" type="submit" disabled={busy} style={{ marginTop: 6 }}>
          {busy ? t('action.working') : mode === 'login' ? t('login.signIn') : first ? t('login.createInstance') : t('login.createAccountSubmit')}
        </button>

        {!first && (config?.allowSignup || mode === 'register') && (
          <button
            type="button" className="btn ghost block" style={{ marginTop: 8 }}
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? t('login.switchToRegister') : t('login.switchToLogin')}
          </button>
        )}
        </>)}

        <div className="row muted" style={{ justifyContent: 'center', marginTop: 18, fontSize: 12, gap: 10 }}>
          <span className="row" style={{ gap: 5 }}><Icon name="bolt" size={13} /> {t('login.footer')}</span>
          <span aria-hidden="true">·</span>
          <select
            className="input"
            aria-label={t('profile.language')}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
            style={{ width: 'auto', padding: '2px 4px', fontSize: 12, border: 'none', background: 'none' }}
          >
            {(Object.keys(LOCALE_NAMES) as Locale[]).map((value) => <option key={value} value={value}>{localeLabel(value)}</option>)}
          </select>
        </div>
      </form>
    </div>
  );
}
