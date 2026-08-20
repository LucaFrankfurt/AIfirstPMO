/**
 * The account-security screens: a second factor, and the devices signed in.
 *
 * Both are built around the same idea — that the dangerous moment is not
 * turning security on, it is being unable to get back in afterwards. So the
 * setup shows the recovery codes exactly once and says so, and the device list
 * marks which row is the one you are reading it on.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useT } from '../lib/i18n';
import { useSession } from '../session';
import { Button } from '../components/ui/button';
import { Icon, useConfirm, useToast } from './ui';

/* ------------------------------------------------------------ two factor */

export function TwoFactor() {
  const t = useT();
  const toast = useToast();
  const { user, refresh } = useSession();
  const { confirm, dialog } = useConfirm();

  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [failed, setFailed] = useState('');
  const on = !!user?.two_factor;

  const start = async () => {
    setFailed('');
    try {
      setSetup(await api.startTwoFactor());
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmSetup = async () => {
    setFailed('');
    try {
      const result = await api.confirmTwoFactor(code.trim());
      setRecovery(result.recovery_codes);
      setSetup(null);
      setCode('');
      await refresh();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('security.twoFactor')}</h3>
      <p className="text-[12px] text-muted" style={{ marginBottom: 8 }}>{t('security.twoFactorHint')}</p>

      {recovery && (
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 13 }}>{t('security.recoveryTitle')}</strong>
          <p className="text-[12px] text-muted">{t('security.recoveryHint')}</p>
          <div className="recovery-codes">
            {recovery.map((one) => <code key={one}>{one}</code>)}
          </div>
          <div className="flex items-center gap-2" style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => {
              void navigator.clipboard?.writeText(recovery.join('\n'));
              toast(t('common.copied'));
            }}>{t('action.copy')}</Button>
            <Button variant="ghost" size="sm" onClick={() => setRecovery(null)}>{t('security.recoverySaved')}</Button>
          </div>
        </div>
      )}

      {on ? (
        <div className="flex items-center gap-2" style={{ gap: 8 }}>
          <span className="chip"><Icon name="check" size={12} /> {t('security.twoFactorOn')}</span>
          <Button variant="danger" size="sm"
            onClick={async () => {
              if (!(await confirm(t('security.turnOffConfirm'), t('security.turnOff')))) return;
              const password = window.prompt(t('security.passwordToTurnOff'));
              if (!password) return;
              try {
                await api.disableTwoFactor(password);
                await refresh();
                toast(t('security.turnedOff'));
              } catch (error) {
                setFailed(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            {t('security.turnOff')}
          </Button>
        </div>
      ) : setup ? (
        <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5">
          <p className="text-[12px] text-muted">{t('security.scanHint')}</p>
          {/* The URI as text rather than a QR image: drawing one needs a
              library, and every authenticator app takes a typed secret. */}
          <div className="field">
            <label htmlFor="totp-secret">{t('security.secret')}</label>
            <input id="totp-secret" className="input" readOnly value={setup.secret.replace(/(.{4})/g, '$1 ').trim()} />
          </div>
          <div className="field">
            <label htmlFor="totp-code">{t('security.enterCode')}</label>
            <input
              id="totp-code" className="input" inputMode="numeric" autoComplete="one-time-code"
              style={{ width: 130, letterSpacing: 2 }}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void confirmSetup()}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={code.trim().length < 6} onClick={() => void confirmSetup()}>
              {t('security.confirm')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSetup(null)}>{t('action.cancel')}</Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => void start()}>{t('security.turnOn')}</Button>
      )}

      {failed && <p className="text-[12px] text-danger" style={{ marginTop: 8 }}>{failed}</p>}
      {dialog}
    </>
  );
}

/* --------------------------------------------------------------- devices */

export function Sessions() {
  const t = useT();
  const toast = useToast();
  const [rows, setRows] = useState<any[] | null>(null);

  const load = () => api.sessions().then(setRows).catch(() => setRows([]));
  useEffect(() => { load(); }, []);

  return (
    <>
      <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>{t('security.devices')}</h3>
      <p className="text-[12px] text-muted" style={{ marginBottom: 8 }}>{t('security.devicesHint')}</p>
      <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" style={{ padding: 0 }}>
        {(rows ?? []).map((row) => (
          <div className="flex items-center gap-2 trash-row" key={row.id} style={{ gap: 9 }}>
            <Icon name={row.current ? 'check' : 'users'} size={14} />
            <span className="flex-1 min-w-0 truncate" title={row.user_agent ?? ''}>
              {describe(row.user_agent) || t('security.unknownDevice')}
            </span>
            {row.current && <span className="chip">{t('security.thisDevice')}</span>}
            <span className="text-muted" style={{ fontSize: 12 }}>{relativeTime(row.last_used_at ?? row.created_at)}</span>
            <Button variant="ghost" size="sm"
              onClick={async () => {
                await api.revokeSession(row.id);
                toast(t('security.revoked'));
                // Revoking this device signs you out here too, so the reload
                // lands on the sign-in screen rather than a dead session.
                if (row.current) location.reload();
                else load();
              }}
            >
              {t('security.revoke')}
            </Button>
          </div>
        ))}
        {rows && !rows.length && <div className="trash-row text-muted" style={{ fontSize: 12.5 }}>{t('security.noDevices')}</div>}
      </div>
    </>
  );
}

/**
 * A user-agent string, shortened to something a person recognises.
 *
 * Not a parser — those are wrong within a year. Three substrings cover almost
 * everything, and the full string is in the tooltip when they do not.
 */
function describe(agent?: string | null): string {
  const text = String(agent ?? '');
  if (!text) return '';
  const browser = /Firefox/.test(text) ? 'Firefox'
    : /Edg\//.test(text) ? 'Edge'
      : /Chrome/.test(text) ? 'Chrome'
        : /Safari/.test(text) ? 'Safari' : '';
  const system = /Android/.test(text) ? 'Android'
    : /iPhone|iPad/.test(text) ? 'iOS'
      : /Mac OS X/.test(text) ? 'macOS'
        : /Windows/.test(text) ? 'Windows'
          : /Linux/.test(text) ? 'Linux' : '';
  return [browser, system].filter(Boolean).join(' · ');
}
