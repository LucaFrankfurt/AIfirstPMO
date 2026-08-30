import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../sync/api';
import { useSession } from '../session';
import { useI18n } from '../../i18n/i18n';
import { AuthLayout } from '../AuthLayout';
import { Button, buttonVariants } from '../../design-system/ui/button';
import { Input, Label } from '../../design-system/ui/field';
import { cn } from '../../design-system/cn';
import { Icon } from '../../design-system/ui';

export function Login() {
  const { t } = useI18n();
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
      // A server-rendered page can send somebody here to sign in and ask to be
      // returned — the OAuth consent screen does, because a connector's popup
      // has no session yet. Only a path on this instance is honoured, and it
      // leaves the app rather than routing inside it, because the page waiting
      // at the other end is not part of the app.
      const next = new URLSearchParams(window.location.search).get('next');
      if (next?.startsWith('/oauth/')) window.location.assign(next);
      else navigate('/');
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
    <AuthLayout>
      <form onSubmit={submit}>
        <h1>{first ? t('login.setupTitle') : mode === 'login' ? t('login.welcomeBack') : t('login.createAccount')}</h1>

        {/* One line under the heading carrying whichever of three things is
            true: you were invited, you are setting the instance up, or you can
            switch to the other mode. The switch used to be a full-width ghost
            button under the submit — which is to say, a decision offered after
            the form had already been filled in. */}
        <p className="auth-sub">
          {invite
            ? t('login.invitedTo', { workspace: invite.workspace_name })
            : first
              ? t('login.firstAccountHint')
              : (config?.allowSignup || mode === 'register') ? (
                <>
                  {mode === 'login' ? t('auth.noAccount') : t('auth.haveAccount')}{' '}
                  <button
                    type="button"
                    className="auth-switch"
                    onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
                  >
                    {/* The action alone. The lead-in already asked the
                        question, and "No account yet? Create an account
                        instead" answers it twice. */}
                    {mode === 'login' ? t('login.createAccountSubmit') : t('login.signIn')}
                  </button>
                </>
              ) : t('login.tagline')}
        </p>

        {error && <div className="error" role="alert">{error}</div>}

        {sso?.only ? (
          <>
            <a className={buttonVariants({ variant: 'primary', size: 'lg', block: true })} href={ssoHref}>
              <Icon name="shield" size={15} /> {t('login.ssoContinue', { provider: sso.label })}
            </a>
            <p className="text-muted text-[12.5px]" style={{ margin: '12px 0 0' }}>{t('login.ssoOnlyHint')}</p>
          </>
        ) : (
          <>
            <div className="auth-fields">
              {mode === 'register' && (
                <Label label={t('login.yourName')}>
                  <Input value={form.name} autoComplete="name"
                    onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </Label>
              )}

              <Label label={t('login.email')}>
                <Input
                  id="email" type="email" required autoComplete="email" autoFocus={mode === 'login'}
                  value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
              </Label>

              <Label label={t('login.password')} hint={mode === 'register' ? t('login.passwordHint') : undefined}>
                <Input
                  id="password" type="password" required minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })}
                />
              </Label>

              {mode === 'register' && !code && (
                <Label label={t('login.workspaceName')}>
                  <Input
                    placeholder={t('login.workspacePlaceholder')} value={form.workspace}
                    onChange={(event) => setForm({ ...form, workspace: event.target.value })}
                  />
                </Label>
              )}
            </div>

            <Button variant="primary" size="lg" block type="submit" disabled={busy} className="mt-5">
              {busy ? t('action.working') : mode === 'login' ? t('login.signIn') : first ? t('login.createInstance') : t('login.createAccountSubmit')}
            </Button>

            {sso && (
              <>
                <div className="divider-text" aria-hidden="true"><span>{t('login.ssoOr')}</span></div>
                <a className={buttonVariants({ variant: 'secondary', size: 'lg', block: true })} href={ssoHref}>
                  <Icon name="shield" size={15} /> {t('login.ssoContinue', { provider: sso.label })}
                </a>
              </>
            )}
          </>
        )}
      </form>
    </AuthLayout>
  );
}

/**
 * An invite link opened by somebody who is *already* signed in.
 *
 * Registering a second time on an instance makes a second workspace — it does
 * not join the first one — so two accounts made that way start out unable to
 * see each other at all: no shared members, no shared projects, nobody in the
 * chat sidebar. An invite is how they come together, and this is the screen
 * that accepts one without signing out first.
 *
 * It exists because the route used to redirect a signed-in visitor to the home
 * page. The endpoint was there, the client function was there, and the one
 * person who most needed them — an account that already exists — was silently
 * bounced past both.
 */
export function AcceptInvite() {
  const { t } = useI18n();
  const { code } = useParams();
  const navigate = useNavigate();
  const { user, refresh, setWorkspace, signOut } = useSession();
  const [invite, setInvite] = useState<{ workspace_name: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) return;
    api.get<{ workspace_name: string }>(`/api/invites/${code}`)
      .then(setInvite)
      .catch(() => setError(t('login.inviteInvalid')));
  }, [code, t]);

  async function join(): Promise<void> {
    if (!code) return;
    setError('');
    setBusy(true);
    try {
      const { workspaceId } = await api.acceptInvite(code);
      // Refresh first: `setWorkspace` switches to a workspace the session has
      // to already know about, or the app opens on an id it cannot name.
      await refresh();
      setWorkspace(workspaceId);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.somethingWentWrong'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      {/* A card, where the sign-in form has none: this is a question with two
          answers rather than something to fill in, and a pair of buttons on an
          open page reads as a screen that has not finished loading. */}
      <div className="box">
        <h1>{t('login.joinTitle')}</h1>
        <p className="auth-sub">
          {invite ? t('login.invitedTo', { workspace: invite.workspace_name }) : t('login.tagline')}
        </p>

        {error && <div className="error" role="alert">{error}</div>}

        {user && (
          <p className="text-muted text-[12.5px]" style={{ margin: '0 0 12px' }}>
            {t('login.signedInAs', { email: user.email ?? '' })}
          </p>
        )}

        <Button variant="primary" size="lg" block type="button" disabled={busy || !invite} onClick={() => void join()}>
          {busy ? t('action.working') : t('login.joinSubmit')}
        </Button>

        {/* Signing out lands back on this same URL with no session, which is
            the sign-in form with the invite already attached. */}
        <button type="button" className={cn(buttonVariants({ variant: 'ghost', block: true }), 'mt-2')} onClick={() => void signOut()}>
          {t('login.useAnotherAccount')}
        </button>
      </div>
    </AuthLayout>
  );
}
