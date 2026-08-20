import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keyFromName } from '../lib/text';
import { Header } from '../components/AppShell';
import { Avatar, Empty, Icon, MenuButton, Progress, useConfirm } from '../components/ui';
import { create, remove, update } from '../lib/mutations';
import { byId, list, useQuery } from '../lib/store';
import { useMembers, useSession } from '../session';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/field';
import { Chip, chipVariants } from '../components/ui/chip';
import { useT } from '../lib/i18n';

export function Teams() {
  const t = useT();
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
      <Header title={t('team.title')} />
      <div className="page">
        <form
          className="flex items-center gap-2 mb-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            create('team', { name: name.trim(), key: keyFromName(name), icon: '👥', color: '#6366f1', archived: 0 });
            setName('');
          }}
        >
          <Input placeholder={t('team.placeholder')} value={name} onChange={(event) => setName(event.target.value)} />
          <Button type="submit"><Icon name="plus" size={14} /> {t('action.add')}</Button>
        </form>

        {!teams.length && (
          <Empty emoji="👥" title={t('team.emptyTitle')} hint={t('team.emptyHint')} guide="teams" />
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
              <div className="rounded-[var(--radius)] border border-line bg-raised p-3.5" key={team.id}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{team.icon ?? '👥'}</span>
                  <Input
                    className="flex-1 min-w-0 font-semibold" style={{ border: 'none', background: 'none' }}
                    value={team.name} onChange={(event) => update('team', team.id, { name: event.target.value })}
                  />
                  <Chip className="font-mono">{team.key}</Chip>
                  <MenuButton
                    variant="ghost" size="iconSm"
                    label={t('common.moreActions')}
                    search
                    items={[
                      ...members.map((member) => {
                        const membership = teamMembers.find((m) => m.team_id === team.id && m.user_id === member.id);
                        return {
                          id: member.id,
                          section: t('team.members'),
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
                        id: 'delete', section: t('team.danger'), label: t('team.delete'), danger: true,
                        onSelect: async () => {
                          if (await confirm(t('team.deleteConfirm', { name: team.name }))) remove('team', team.id);
                        },
                      },
                    ]}
                  >
                    <Icon name="dots" size={14} />
                  </MenuButton>
                </div>

                <div className="flex items-center gap-2 flex-wrap gap-1.5 mb-2.5">
                  {people.map((person) => (
                    <span className={chipVariants()} key={person.id}>
                      <Avatar user={person} size={16} /> {person.name}
                    </span>
                  ))}
                  {!people.length && <span className="text-muted text-[12.5px]">{t('team.noMembers')}</span>}
                </div>

                <Progress value={done} total={tasks.length} />
                <div className="flex items-center gap-2 text-muted text-[12.5px] mt-1.5">
                  <span>{t('team.projectCount', { count: teamProjects.length })}</span>
                  <span className="flex-1 min-w-0" />
                  <span>{t('team.tasksDone', { done, total: tasks.length })}</span>
                </div>

                <div className="flex items-center gap-2 flex-wrap gap-1.5 mt-2.5">
                  {teamProjects.map((project) => (
                    <button className={chipVariants({ interactive: true })} key={project.id} onClick={() => navigate(`/projects/${project.id}`)}>
                      {project.icon} {project.name}
                    </button>
                  ))}
                  <MenuButton
                    className={chipVariants({ interactive: true })}
                    items={projects.map((project) => ({
                      id: project.id,
                      label: `${project.icon ?? ''} ${project.name}`.trim(),
                      hint: project.team_id === team.id ? '✓' : undefined,
                      onSelect: () => update('project', project.id, { team_id: project.team_id === team.id ? null : team.id }),
                    }))}
                  >
                    <Icon name="plus" size={12} /> {t('team.addProject')}
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
