import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { list, useQuery } from '../lib/store';
import { excerpt } from '../lib/markdown';
import { useSession } from '../session';
import { Icon, StateDot } from './ui';
import { stateOf } from './task-parts';

interface Command {
  id: string;
  icon: string;
  title: string;
  hint?: string;
  run: () => void;
}

/**
 * ⌘K search over everything already in the local cache — so it answers while
 * offline and never waits for a request.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { workspaceId } = useSession();
  const listRef = useRef<HTMLDivElement>(null);

  const tasks = useQuery(() => list('task', (t) => t.workspace_id === workspaceId && !t.archived), [workspaceId]);
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId), [workspaceId]);
  const pages = useQuery(() => list('page', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    const navigation: Command[] = [
      { id: 'nav-my', icon: 'home', title: 'My work', run: go('/') },
      { id: 'nav-inbox', icon: 'inbox', title: 'Inbox', run: go('/inbox') },
      { id: 'nav-pages', icon: 'page', title: 'Pages', run: go('/pages') },
      { id: 'nav-teams', icon: 'users', title: 'Teams', run: go('/teams') },
      { id: 'nav-settings', icon: 'settings', title: 'Settings', run: go('/settings') },
      { id: 'nav-new-project', icon: 'plus', title: 'New project', run: go('/projects/new') },
    ];

    const needle = query.trim().toLowerCase();
    const match = (text: string) => !needle || text.toLowerCase().includes(needle);

    const taskCommands = tasks
      .filter((task) => match(`${task.identifier} ${task.title}`))
      .slice(0, 20)
      .map((task) => ({
        id: task.id,
        icon: 'check',
        title: task.title,
        hint: task.identifier,
        run: () => {
          navigate(`/t/${task.id}`);
          onClose();
        },
      }));

    const projectCommands = projects
      .filter((project) => match(`${project.name} ${project.key}`))
      .slice(0, 8)
      .map((project) => ({
        id: project.id,
        icon: 'folder',
        title: `${project.icon ?? ''} ${project.name}`.trim(),
        hint: project.key,
        run: go(`/projects/${project.id}`),
      }));

    const pageCommands = pages
      .filter((page) => match(`${page.title} ${excerpt(page.content, 200)}`))
      .slice(0, 8)
      .map((page) => ({
        id: page.id,
        icon: 'page',
        title: page.title,
        hint: 'Page',
        run: go(`/pages/${page.id}`),
      }));

    return [
      ...taskCommands,
      ...projectCommands,
      ...pageCommands,
      ...navigation.filter((command) => match(command.title)),
    ];
  }, [query, tasks, projects, pages, navigate, onClose]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((current) => Math.min(current + 1, commands.length - 1));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((current) => Math.max(current - 1, 0));
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        commands[active]?.run();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [commands, active, onClose]);

  useEffect(() => {
    listRef.current?.querySelector('.highlight')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return createPortal(
    <div className="palette" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="box">
        <input
          autoFocus
          placeholder="Search tasks, projects and pages…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="results menu" ref={listRef} style={{ position: 'static', border: 'none', boxShadow: 'none', maxHeight: 'none' }}>
          {commands.length === 0 && <div className="section">Nothing matches “{query}”</div>}
          {commands.map((command, index) => (
            <button
              key={command.id}
              className={index === active ? 'highlight' : ''}
              onPointerEnter={() => setActive(index)}
              onClick={command.run}
            >
              <Icon name={command.icon} size={15} />
              <span className="grow truncate">{command.title}</span>
              {command.hint && <span className="muted mono">{command.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Tiny status marker reused in search results. */
export function TaskGlyph({ taskId }: { taskId: string }) {
  const task = useQuery(() => list('task', (t) => t.id === taskId)[0], [taskId]);
  const state = task ? stateOf(task) : undefined;
  return <StateDot group={state?.group_key} color={state?.color} />;
}
