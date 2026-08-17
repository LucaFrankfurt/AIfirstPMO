import { useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { TaskDetail } from './components/TaskDetail';
import { Empty, ToastHost } from './components/ui';
import { Login } from './routes/Login';
import { Inbox, More, MyWork, Search } from './routes/personal';
import { CyclePage, ModulePage, ProjectList, ProjectNew, ProjectPage } from './routes/projects';
import { PageDetail, PagesIndex } from './routes/pages';
import { Settings } from './routes/settings';
import { Teams } from './routes/teams';
import { useSession } from './session';

/** Tasks are addressable, so a link into a task opens it over the last screen. */
function TaskRoute() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  return (
    <TaskDetail
      taskId={id}
      onClose={() => navigate(-1)}
      onOpen={(task) => navigate(`/t/${task.id}`, { replace: true })}
    />
  );
}

function Boot() {
  return (
    <div className="auth">
      <div className="col" style={{ alignItems: 'center', gap: 14 }}>
        <img src="/icon.svg" width={46} height={46} alt="" style={{ borderRadius: 12 }} />
        <div className="skeleton" style={{ width: 160, height: 10 }} />
      </div>
    </div>
  );
}

export default function App() {
  const { ready, session, workspaceId } = useSession();

  useEffect(() => {
    if ('serviceWorker' in navigator && import.meta.env.PROD) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

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

  if (!workspaceId) {
    return (
      <ToastHost>
        <Empty emoji="🏗️" title="No workspace yet" hint="Create one in settings to get started." />
      </ToastHost>
    );
  }

  return (
    <ToastHost>
      <AppShell>
        <Routes>
          <Route path="/" element={<MyWork />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/search" element={<Search />} />
          <Route path="/more" element={<More />} />
          <Route path="/projects" element={<ProjectList />} />
          <Route path="/projects/new" element={<ProjectNew />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/cycles/:id" element={<CyclePage />} />
          <Route path="/modules/:id" element={<ModulePage />} />
          <Route path="/pages" element={<PagesIndex />} />
          <Route path="/pages/:id" element={<PageDetail />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/settings/*" element={<Settings />} />
          <Route path="/invite/:code" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Empty emoji="🧭" title="Page not found" />} />
        </Routes>
      </AppShell>
      <Routes>
        <Route path="/t/:id" element={<TaskRoute />} />
      </Routes>
    </ToastHost>
  );
}
