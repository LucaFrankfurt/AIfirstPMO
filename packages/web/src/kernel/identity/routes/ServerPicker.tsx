import { useState } from 'react';
import { useI18n } from '../../i18n/i18n';
import { Button } from '../../design-system/ui/button';
import { Input } from '../../design-system/ui/field';
import { api } from '../../sync/api';
import { useServer } from '../../sync/server';
import { AuthLayout } from '../AuthLayout';

/**
 * The one screen a browser never sees: which Kolibri is this?
 *
 * A packaged app is not served by anybody — it loads its bundle from its own
 * origin — so it has no idea where the instance is until somebody types it.
 * That is the price of self-hosting on a phone, and the whole of the extra
 * flow: after this, sign-in is the same screen as everywhere else.
 *
 * The address is checked before it is kept. `/api/config` is public, cheap and
 * exists on every version, so it answers the two questions that matter — is
 * something there, and is it a Kolibri — without a password. Storing an
 * unchecked address instead would move the failure to the sign-in screen,
 * where it looks like a wrong password.
 */
export function ServerPicker({ onReady }: { onReady: () => void }) {
  const { t } = useI18n();
  const [address, setAddress] = useState('https://');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setProblem(null);
    setChecking(true);
    // Kept before the check, because `api` reads the origin from here; put back
    // if the address turns out not to be a Kolibri, so a typo is not sticky.
    useServer(address);
    try {
      await api.config();
      onReady();
    } catch {
      useServer('');
      setProblem(t('server.unreachable'));
    } finally {
      setChecking(false);
    }
  }

  return (
    <AuthLayout>
      <form className="auth-fields" onSubmit={connect}>
        <h1>{t('server.title')}</h1>
        <p className="auth-sub">{t('server.explain')}</p>
        <label>
          <span>{t('server.address')}</span>
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://kolibri.example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            required
          />
        </label>
        {problem && <p role="alert" className="error">{problem}</p>}
        <Button type="submit" disabled={checking}>
          {checking ? t('server.checking') : t('server.connect')}
        </Button>
      </form>
    </AuthLayout>
  );
}
