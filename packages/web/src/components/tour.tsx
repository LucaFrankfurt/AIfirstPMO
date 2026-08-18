/**
 * First-run tour and setup checklist.
 *
 * Two different jobs, deliberately not merged:
 *
 *   - The **tour** runs once and *does* things rather than pointing at them.
 *     Picking a language, creating the first project and copying an invite
 *     link all happen inside it, so somebody who follows it to the end has a
 *     working workspace rather than a memory of some screenshots. It adapts:
 *     steps that do not apply (a member who cannot invite, an instance that
 *     already has projects) are not shown at all.
 *   - The **checklist** stays. Its ticks are derived from the actual data, not
 *     from "has the user clicked this", so it is honest after a restore, on a
 *     second device, or when somebody else did the work.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { LOCALE_NAMES, useI18n, type Locale, type TranslationKey } from '../lib/i18n';
import { list, useQuery } from '../lib/store';
import { pull } from '../lib/sync';
import { useMembers, useSession } from '../session';
import { THEME_KEY, useTheme } from './AppShell';
import { OverviewDiagram } from './diagrams';
import { Icon, Sheet, useToast } from './ui';

const TOUR_KEY = 'kolibri.tour';
const CHECKLIST_KEY = 'kolibri.setup';

/** Other screens ask for the tour by event, so nothing has to own its state. */
export const START_TOUR = 'kolibri:tour';
export const SHOW_CHECKLIST = 'kolibri:setup';

/* ------------------------------------------------------------------ tour */

type Step = 'welcome' | 'prefs' | 'project' | 'invite' | 'done';

export function WelcomeTour() {
  const { t, locale, setLocale } = useI18n();
  const { workspaceId, role, refresh } = useSession();
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();
  const toast = useToast();

  const [open, setOpen] = useState(() => localStorage.getItem(TOUR_KEY) !== 'done');
  const [index, setIndex] = useState(0);
  const [projectName, setProjectName] = useState('');
  const [created, setCreated] = useState('');
  const [invited, setInvited] = useState(false);
  const [busy, setBusy] = useState(false);

  const canManage = role === 'owner' || role === 'admin';

  useEffect(() => {
    const start = () => {
      setIndex(0);
      setCreated('');
      setInvited(false);
      setOpen(true);
    };
    window.addEventListener(START_TOUR, start);
    return () => window.removeEventListener(START_TOUR, start);
  }, []);

  if (!open || !workspaceId) return null;

  // Only the steps that have something to offer this person. Creating a
  // project and inviting people are both refused for a plain member, so
  // showing them would be showing a wall.
  const steps: Step[] = [
    'welcome',
    'prefs',
    ...(canManage ? (['project', 'invite'] as Step[]) : []),
    'done',
  ];
  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;

  const finish = () => {
    localStorage.setItem(TOUR_KEY, 'done');
    setOpen(false);
  };

  async function createProject(): Promise<void> {
    if (!projectName.trim()) return;
    setBusy(true);
    try {
      const project = await api.post<{ name: string }>(`/api/workspaces/${workspaceId}/projects`, { name: projectName.trim() });
      await pull();
      setCreated(project.name);
    } catch (error) {
      toast(error instanceof Error ? error.message : t('project.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function createInvite(): Promise<void> {
    setBusy(true);
    try {
      const invite = await api.createInvite(workspaceId, 'member');
      await navigator.clipboard?.writeText(`${location.origin}/invite/${invite.code}`);
      setInvited(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : t('common.somethingWentWrong'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      wide
      title={t('tour.title')}
      onClose={finish}
      footer={
        <>
          <span className="muted grow" style={{ fontSize: 12 }}>
            {t('tour.stepOf', { current: index + 1, total: steps.length })}
          </span>
          {index > 0 && <button className="btn" onClick={() => setIndex(index - 1)}>{t('tour.back')}</button>}
          {!last && <button className="btn" onClick={finish}>{t('tour.skip')}</button>}
          <button className="btn primary" onClick={() => (last ? finish() : setIndex(index + 1))}>
            {last ? t('tour.finish') : t('tour.next')}
          </button>
        </>
      }
    >
      {step === 'welcome' && (
        <>
          <h3 className="tour-h">{t('tour.welcomeTitle')}</h3>
          <p className="soft">{t('tour.welcomeBody')}</p>
          <OverviewDiagram />
        </>
      )}

      {step === 'prefs' && (
        <>
          <h3 className="tour-h">{t('tour.prefsTitle')}</h3>
          <p className="soft">{t('tour.prefsBody')}</p>

          <div className="field">
            <label htmlFor="tour-locale">{t('profile.language')}</label>
            <select
              id="tour-locale"
              className="select"
              value={locale}
              onChange={async (event) => {
                const next = event.target.value as Locale;
                setLocale(next);
                await api.patch('/api/me', { locale: next }).catch(() => undefined);
                await refresh();
              }}
            >
              {Object.entries(LOCALE_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>

          <div className="field">
            <label>{t('profile.appearance')}</label>
            <div className="row" style={{ gap: 6 }}>
              {(['system', 'light', 'dark'] as const).map((option) => (
                <button
                  key={option}
                  className={`btn sm${theme === option ? ' primary' : ''}`}
                  onClick={() => setTheme(option)}
                >
                  <Icon name={option === 'dark' ? 'moon' : option === 'light' ? 'sun' : 'settings'} size={14} />
                  {t(THEME_KEY[option])}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {step === 'project' && (
        <>
          <h3 className="tour-h">{t('tour.projectTitle')}</h3>
          <p className="soft">{t('tour.projectBody')}</p>
          {created ? (
            <p className="tour-ok"><Icon name="check" size={15} /> {t('tour.projectDone', { name: created })}</p>
          ) : (
            <div className="row">
              <input
                className="input"
                autoFocus
                placeholder={t('project.namePlaceholder')}
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && void createProject()}
              />
              <button className="btn primary" disabled={busy || !projectName.trim()} onClick={() => void createProject()}>
                {busy ? t('project.creating') : t('project.createSubmit')}
              </button>
            </div>
          )}
        </>
      )}

      {step === 'invite' && (
        <>
          <h3 className="tour-h">{t('tour.inviteTitle')}</h3>
          <p className="soft">{t('tour.inviteBody')}</p>
          {invited ? (
            <p className="tour-ok"><Icon name="check" size={15} /> {t('tour.inviteReady')}</p>
          ) : (
            <button className="btn" disabled={busy} onClick={() => void createInvite()}>
              <Icon name="link" size={14} /> {t('members.createInvite')}
            </button>
          )}
        </>
      )}

      {step === 'done' && (
        <>
          <h3 className="tour-h">{t('tour.doneTitle')}</h3>
          <p className="soft">{t('tour.doneBody')}</p>
          <div className="row wrap" style={{ gap: 8 }}>
            <button
              className="btn"
              onClick={() => {
                finish();
                navigate('/guide');
              }}
            >
              <Icon name="help" size={14} /> {t('tour.openGuide')}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------- checklist */

interface Item {
  id: string;
  done: boolean;
  label: TranslationKey;
  hint: TranslationKey;
  cta: TranslationKey;
  run: () => void;
}

export function SetupChecklist() {
  const { t } = useI18n();
  const { workspaceId, role } = useSession();
  const navigate = useNavigate();
  const members = useMembers();
  const [hidden, setHidden] = useState(() => localStorage.getItem(CHECKLIST_KEY) === 'hidden');
  const [allowSignup, setAllowSignup] = useState<boolean | null>(null);

  const canManage = role === 'owner' || role === 'admin';

  const counts = useQuery(() => ({
    projects: list('project', (p) => p.workspace_id === workspaceId && !p.archived).length,
    tasks: list('task', (task) => task.workspace_id === workspaceId).length,
    pages: list('page', (page) => page.workspace_id === workspaceId && !page.archived).length,
  }), [workspaceId]);

  useEffect(() => {
    if (!canManage) return;
    api.config().then((config) => setAllowSignup(config.allowSignup)).catch(() => setAllowSignup(null));
  }, [canManage]);

  useEffect(() => {
    const show = () => {
      localStorage.removeItem(CHECKLIST_KEY);
      setHidden(false);
    };
    window.addEventListener(SHOW_CHECKLIST, show);
    return () => window.removeEventListener(SHOW_CHECKLIST, show);
  }, []);

  const items: Item[] = [
    {
      id: 'project', done: counts.projects > 0,
      label: 'setup.project', hint: 'setup.projectHint', cta: 'setup.projectCta',
      run: () => navigate('/projects/new'),
    },
    {
      id: 'task', done: counts.tasks > 0,
      label: 'setup.task', hint: 'setup.taskHint', cta: 'setup.taskCta',
      // AppShell owns the quick-add sheet; asking for it by event keeps the
      // checklist from having to be mounted inside it.
      run: () => window.dispatchEvent(new CustomEvent('kolibri:new-task')),
    },
    {
      id: 'page', done: counts.pages > 0,
      label: 'setup.page', hint: 'setup.pageHint', cta: 'setup.pageCta',
      run: () => navigate('/pages'),
    },
    ...(canManage ? [
      {
        id: 'invite', done: members.length > 1,
        label: 'setup.invite' as TranslationKey, hint: 'setup.inviteHint' as TranslationKey, cta: 'setup.inviteCta' as TranslationKey,
        run: () => navigate('/settings?tab=members'),
      },
      {
        id: 'signup', done: allowSignup === false,
        label: 'setup.signup' as TranslationKey, hint: 'setup.signupHint' as TranslationKey, cta: 'setup.signupCta' as TranslationKey,
        run: () => navigate('/settings?tab=workspace'),
      },
    ] : []),
  ];

  const done = items.filter((item) => item.done).length;
  // Nothing left to nag about, and nothing to nag someone who dismissed it.
  if (hidden || done === items.length) return null;

  return (
    <section className="card setup" aria-label={t('setup.title')}>
      <div className="row" style={{ marginBottom: 10 }}>
        <strong style={{ fontSize: 13.5 }}>{t('setup.title')}</strong>
        <span className="muted" style={{ fontSize: 12 }}>{t('setup.progress', { done, total: items.length })}</span>
        <span className="grow" />
        <Link className="btn ghost sm" to="/guide"><Icon name="help" size={13} /> <span className="hide-sm">{t('nav.guide')}</span></Link>
        <button
          className="btn ghost sm"
          onClick={() => {
            localStorage.setItem(CHECKLIST_KEY, 'hidden');
            setHidden(true);
          }}
        >
          {t('setup.hide')}
        </button>
      </div>

      <div className="progress" style={{ marginBottom: 12 }}>
        <i style={{ width: `${(done / items.length) * 100}%` }} />
      </div>

      {items.map((item) => (
        <div className={`setup-item${item.done ? ' done' : ''}`} key={item.id}>
          <span className="setup-tick">{item.done && <Icon name="check" size={12} />}</span>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="setup-label">{t(item.label)}</span>
            <span className="setup-hint">{t(item.hint)}</span>
          </span>
          {!item.done && <button className="btn sm" onClick={item.run}>{t(item.cta)}</button>}
        </div>
      ))}
    </section>
  );
}
