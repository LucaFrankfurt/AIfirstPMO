import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keyFromName } from '../lib/text';
import { Header } from '../components/AppShell';
import { Avatar, Empty, Icon, MenuButton, Progress, useConfirm } from '../components/ui';
import { create, remove, update } from '../lib/mutations';
import { byId, list, useQuery } from '../lib/store';
import { useMembers, useSession } from '../session';

export function Teams() {
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const members = useMembers();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState('');

  const teams = useQuery(() => list('team', (t) => t.workspace_id === workspaceId && !t.archived), [workspaceId]);
  const teamMembers = useQuery(() => list('teamMember', (m) => m.workspace_id === workspaceId), [workspaceId]);
  const projects = useQuery(() => list('project', (p) => p.workspace_id === workspaceId && !p.archived), [workspaceId]);

  return (
    <>
      <Header title="Teams" />
      <div className="page">
        <form
          className="row" style={{ marginBottom: 16 }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            create('team', { name: name.trim(), key: keyFromName(name), icon: '👥', color: '#6366f1', archived: 0 });
            setName('');
          }}
        >
          <input className="input" placeholder="New team, e.g. Platform" value={name} onChange={(event) => setName(event.target.value)} />
          <button className="btn" type="submit"><Icon name="plus" size={14} /> Add</button>
        </form>

        {!teams.length && (
          <Empty emoji="👥" title="No teams yet" hint="Teams group people and projects — useful once more than a handful of people share the workspace." />
        )}

        <div className="grid two">
          {teams.map((team) => {
            const people = teamMembers
              .filter((membership) => membership.team_id === team.id)
              .map((membership) => byId('user', membership.user_id))
              .filter(Boolean) as any[];
            const teamProjects = projects.filter((project) => project.team_id === team.id);
            const tasks = list('task', (task) => teamProjects.some((project) => project.id === task.project_id) && !task.archived);
            const done = tasks.filter((task) => ['completed', 'cancelled'].includes(byId('state', task.state_id)?.group_key ?? '')).length;

            return (
              <div className="card" key={team.id}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span style={{ fontSize: 18 }}>{team.icon ?? '👥'}</span>
                  <input
                    className="input grow" style={{ border: 'none', background: 'none', fontWeight: 600 }}
                    value={team.name} onChange={(event) => update('team', team.id, { name: event.target.value })}
                  />
                  <span className="chip mono">{team.key}</span>
                  <MenuButton
                    className="btn ghost sm icon"
                    search
                    items={[
                      ...members.map((member) => {
                        const membership = teamMembers.find((m) => m.team_id === team.id && m.user_id === member.id);
                        return {
                          id: member.id,
                          section: 'Members',
                          label: member.name,
                          hint: membership ? '✓' : undefined,
                          icon: <Avatar user={member} size={20} />,
                          onSelect: () => {
                            if (membership) remove('teamMember', membership.id);
                            else create('teamMember', { team_id: team.id, user_id: member.id, role: 'member' });
                          },
                        };
                      }),
                      {
                        id: 'delete', section: 'Danger', label: 'Delete team', danger: true,
                        onSelect: async () => {
                          if (await confirm(`Delete the team “${team.name}”? Projects stay, they just lose the team.`)) remove('team', team.id);
                        },
                      },
                    ]}
                  >
                    <Icon name="dots" size={14} />
                  </MenuButton>
                </div>

                <div className="row wrap" style={{ gap: 6, marginBottom: 10 }}>
                  {people.map((person) => (
                    <span className="chip" key={person.id}>
                      <Avatar user={person} size={16} /> {person.name}
                    </span>
                  ))}
                  {!people.length && <span className="muted" style={{ fontSize: 12.5 }}>No members yet</span>}
                </div>

                <Progress value={done} total={tasks.length} />
                <div className="row muted" style={{ fontSize: 12, marginTop: 6 }}>
                  <span>{teamProjects.length} project{teamProjects.length === 1 ? '' : 's'}</span>
                  <span className="grow" />
                  <span>{done}/{tasks.length} tasks done</span>
                </div>

                <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
                  {teamProjects.map((project) => (
                    <button className="chip button" key={project.id} onClick={() => navigate(`/projects/${project.id}`)}>
                      {project.icon} {project.name}
                    </button>
                  ))}
                  <MenuButton
                    className="chip button"
                    items={projects.map((project) => ({
                      id: project.id,
                      label: `${project.icon ?? ''} ${project.name}`.trim(),
                      hint: project.team_id === team.id ? '✓' : undefined,
                      onSelect: () => update('project', project.id, { team_id: project.team_id === team.id ? null : team.id }),
                    }))}
                  >
                    <Icon name="plus" size={12} /> project
                  </MenuButton>
                </div>
              </div>
            );
          })}
        </div>
        {dialog}
      </div>
    </>
  );
}
