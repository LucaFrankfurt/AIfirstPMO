import { Component, Suspense, lazy, useEffect, type ReactNode } from 'react';
import { Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from './AppShell';
import { TaskDetail } from './modules/work/TaskDetail';
import { Empty, ToastHost } from './kernel/design-system/ui';
import { Button } from './kernel/design-system/ui/button';
import { WelcomeTour } from './modules/guide/tour';
import { AcceptInvite, Login } from './kernel/identity/routes/Login';
import { Portfolio } from './modules/planning/portfolio';
import { Planner } from './modules/planning/planner';
import { Inbox, More, MyWork } from './modules/work/routes/personal';
import { Search } from './kernel/search/routes/search';
import { CyclePage, ModulePage, ProjectList, ProjectNew, ProjectPage } from './modules/planning/routes/projects';
import { PageDetail, PagesIndex } from './modules/pages/routes/pages';
import { Chat } from './modules/chat/routes/chat';
import { Teams } from './modules/work/routes/teams';

/**
 * The screens that are not in the first load.
 *
 * Two kinds, and the line between them is deliberate. Four are behind a
 * workspace switch — a workspace with budgets off has no link to budgets on
 * either navigation, and used to download all 2 234 lines of them anyway. The
 * other two are simply never open when the app starts: nobody boots into the
 * manual or into settings, and between them they are another 2 568 lines.
 *
 * Everything else stays eager on purpose. A screen somebody reaches several
 * times an hour — the board, chat, a page, the search box — must not spend a
 * frame on a spinner to save bytes on a file they were always going to need.
 */
const TimesheetPage = lazy(() => import('./modules/time/routes/timesheet').then((m) => ({ default: m.TimesheetPage })));
const Infrastructure = lazy(() => import('./modules/infrastructure/routes/infrastructure').then((m) => ({ default: m.Infrastructure })));
const KpiIndex = lazy(() => import('./modules/kpis/routes/kpis').then((m) => ({ default: m.KpiIndex })));
const KpiDetail = lazy(() => import('./modules/kpis/routes/kpis').then((m) => ({ default: m.KpiDetail })));
const BudgetIndex = lazy(() => import('./modules/budgets/routes/budgets').then((m) => ({ default: m.BudgetIndex })));
const BudgetDetail = lazy(() => import('./modules/budgets/routes/budgets').then((m) => ({ default: m.BudgetDetail })));
const Help = lazy(() => import('./modules/guide/routes/help').then((m) => ({ default: m.Help })));
const Settings = lazy(() => import('./modules/operations/routes/settings').then((m) => ({ default: m.Settings })));
import { backgroundOf, stackDepth, useOpenTask, useTaskRef } from './kernel/design-system/navigation';
import { useFeatures, useSession } from './kernel/identity/session';
import { useI18n, type Locale } from './kernel/i18n/i18n';

/** Tasks are addressable, so a link into a task opens it over the last screen. */
function TaskRoute() {
  const { id = '' } = useParams();
  const taskId = useTaskRef(id);
  const navigate = useNavigate();
  const location = useLocation();
  const openTask = useOpenTask();
  const close = () => {
    // Went straight to the link: there is nothing to go back to.
    // Otherwise pop the whole stack — a sub-task opened from a task is a second
    // history entry, and closing should not make somebody dismiss the sheet
    // they came from as well. Browser Back still walks them one at a time.
    if (backgroundOf(location)) navigate(-stackDepth(location));
    else navigate('/', { replace: true });
  };
  return <TaskDetail taskId={taskId} onClose={close} onOpen={openTask} />;
}

function Boot() {
  return (
    <div className="auth">
      <div className="flex flex-col gap-3.5" style={{ alignItems: 'center' }}>
        <img src="/icon.svg" width={46} height={46} alt="" style={{ borderRadius: 12 }} />
        <div className="skeleton" style={{ width: 160, height: 10 }} />
      </div>
    </div>
  );
}

/**
 * What a screen that could not be fetched looks like.
 *
 * Splitting the optional screens out of the bundle bought a smaller first load
 * and one new way to fail: a chunk can be missing. Two ways, really — the
 * network went away before the idle warm-up reached it, or a deploy replaced
 * the file whose fingerprinted name this tab still remembers. The second is the
 * common one and reloading genuinely fixes it, which is why the button says so
 * rather than apologising.
 *
 * A class because that is the only thing React lets catch a render error, and
 * `Empty` does the actual talking so it looks like every other empty screen.
 */
class ScreenBoundary extends Component<{ children: ReactNode; label: string; hint: string; retry: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Empty
        emoji="📡"
        title={this.props.label}
        hint={this.props.hint}
        action={<Button onClick={() => window.location.reload()}>{this.props.retry}</Button>}
      />
    );
  }
}

export default function App() {
  const { t, adoptLocale } = useI18n();
  const { ready, session, workspaceId } = useSession();
  const has = useFeatures();
  const location = useLocation();
  const background = backgroundOf(location);

  useEffect(() => {
    if ('serviceWorker' in navigator && import.meta.env.PROD) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

  /**
   * Fetch the screens that were kept out of the first load, once there is
   * nothing better for the browser to do.
   *
   * Without this, splitting them would have quietly cost the thing this app is
   * built around: the service worker caches `/assets/` on first request, so a
   * chunk nobody has opened yet is a chunk that is not on the device — and
   * opening Settings on a train would have found nothing to load. Warming them
   * in the idle callback keeps both halves: they are off the critical path, and
   * they are on disk a second or two later.
   *
   * Narrowed by the same switches the navigation uses, because a workspace with
   * budgets off has no way to reach that screen and no reason to hold it.
   */
  useEffect(() => {
    if (!session || !workspaceId) return undefined;
    const warm = () => {
      const fetchQuietly = (load: () => Promise<unknown>) => void load().catch(() => undefined);
      fetchQuietly(() => import('./modules/guide/routes/help'));
      fetchQuietly(() => import('./modules/operations/routes/settings'));
      if (has('time')) fetchQuietly(() => import('./modules/time/routes/timesheet'));
      if (has('infrastructure')) fetchQuietly(() => import('./modules/infrastructure/routes/infrastructure'));
      if (has('kpi')) fetchQuietly(() => import('./modules/kpis/routes/kpis'));
      if (has('budget')) fetchQuietly(() => import('./modules/budgets/routes/budgets'));
    };
    const idle = window.requestIdleCallback;
    if (idle) {
      const handle = idle(warm, { timeout: 5000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `has` is a fresh closure each render
  }, [session, workspaceId]);

  // A device that has never been told otherwise follows the account's language,
  // so signing in on a new phone does not land in the wrong one.
  const accountLocale = session?.user?.locale;
  useEffect(() => {
    if (accountLocale) adoptLocale(accountLocale as Locale);
  }, [accountLocale, adoptLocale]);

  if (!ready) return <Boot />;

  if (!session) {
    return (
      <ToastHost>
        <Routes>
          <Route path="/invite/:code" element={<Login />} />
          <Route path="*" element={<Login />} />
        </Routes>
      </ToastHost>
    );
  }

  // An invite is accepted on a screen of its own rather than inside the app
  // shell: the workspace it is about is not the one open behind it, so the
  // sidebar beside it would be pointing at the wrong place — and an account
  // with no workspace at all still has to be able to join one.
  if (location.pathname.startsWith('/invite/')) {
    return (
      <ToastHost>
        <Routes>
          <Route path="/invite/:code" element={<AcceptInvite />} />
        </Routes>
      </ToastHost>
    );
  }

  if (!workspaceId) {
    return (
      <ToastHost>
        <Empty emoji="🏗️" title={t('misc.noWorkspaceTitle')} hint={t('misc.noWorkspaceHint')} />
      </ToastHost>
    );
  }

  return (
    <ToastHost>
      <AppShell>
        {/* The sheet renders over the screen recorded in the router state, so
            the page behind it never flickers or falls back to a 404. */}
        <ScreenBoundary
          label={t('misc.screenUnavailableTitle')}
          hint={t('misc.screenUnavailableHint')}
          retry={t('misc.reload')}
        >
        <Suspense fallback={<Boot />}>
        <Routes location={background ?? location}>
          <Route path="/" element={<MyWork />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/search" element={<Search />} />
          <Route path="/more" element={<More />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/planner" element={<Planner />} />
          <Route path="/projects" element={<ProjectList />} />
          <Route path="/projects/new" element={<ProjectNew />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/cycles/:id" element={<CyclePage />} />
          <Route path="/modules/:id" element={<ModulePage />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/chat/:id" element={<Chat />} />
          <Route path="/timesheet" element={<TimesheetPage />} />
          <Route path="/infrastructure" element={<Infrastructure />} />
          <Route path="/kpis" element={<KpiIndex />} />
          <Route path="/kpis/:id" element={<KpiDetail />} />
          <Route path="/budgets" element={<BudgetIndex />} />
          <Route path="/budgets/:id" element={<BudgetDetail />} />
          <Route path="/pages" element={<PagesIndex />} />
          <Route path="/pages/:id" element={<PageDetail />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/guide" element={<Help />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="/t/:id" element={<MyWork />} />
          <Route path="*" element={<Empty emoji="🧭" title={t('misc.pageNotFound')} />} />
        </Routes>
        </Suspense>
        </ScreenBoundary>
      </AppShell>
      {/* The sheet, in its own switch so it can sit over any screen. The
          catch-all is the "nothing here, on purpose" — without it every
          location that is not a task logs a warning about matching nothing. */}
      <Routes>
        <Route path="/t/:id" element={<TaskRoute />} />
        <Route path="*" element={null} />
      </Routes>
      <WelcomeTour />
    </ToastHost>
  );
}
