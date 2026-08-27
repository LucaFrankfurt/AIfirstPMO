import { useEffect } from 'react';
import { Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { TaskDetail } from './components/TaskDetail';
import { Empty, ToastHost } from './components/ui';
import { WelcomeTour } from './components/tour';
import { AcceptInvite, Login } from './routes/Login';
import { Portfolio } from './components/portfolio';
import { Planner } from './components/planner';
import { Inbox, More, MyWork } from './routes/personal';
import { Search } from './routes/search';
import { CyclePage, ModulePage, ProjectList, ProjectNew, ProjectPage } from './routes/projects';
import { PageDetail, PagesIndex } from './routes/pages';
import { Chat } from './routes/chat';
import { Help } from './routes/help';
import { Settings } from './routes/settings';
import { Teams } from './routes/teams';
import { backgroundOf, stackDepth, useOpenTask, useTaskRef } from './lib/navigation';
import { useSession } from './session';
import { useI18n, type Locale } from './lib/i18n';

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

export default function App() {
  const { t, adoptLocale } = useI18n();
  const { ready, session, workspaceId } = useSession();
  const location = useLocation();
  const background = backgroundOf(location);

  useEffect(() => {
    if ('serviceWorker' in navigator && import.meta.env.PROD) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

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
          <Route path="/pages" element={<PagesIndex />} />
          <Route path="/pages/:id" element={<PageDetail />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/guide" element={<Help />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="/t/:id" element={<MyWork />} />
          <Route path="*" element={<Empty emoji="🧭" title={t('misc.pageNotFound')} />} />
        </Routes>
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
