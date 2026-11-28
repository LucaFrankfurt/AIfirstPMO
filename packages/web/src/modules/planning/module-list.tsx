/** A project's modules, and the editor a module is made and changed in. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { coversProject, isDoneGroup, orderKey } from '@kolibri/shared';
import { ProjectScopeField, useScopeChoice } from './scope-field';
import type { MarkdownEditor } from '../pages/Markdown';
import { Avatar } from '../../kernel/design-system/ui/avatar';
import { Empty } from '../../kernel/design-system/ui/empty';
import { Icon } from '../../kernel/design-system/ui/icon';
import { MenuButton } from '../../kernel/design-system/ui/menu-button';
import { Progress } from '../../kernel/design-system/ui/progress';
import { Sheet, useConfirm } from '../../kernel/design-system/ui/sheet';
import { shortDate } from '../../kernel/design-system/format';
import { create, remove, update } from '../../kernel/sync/mutations';
import { useSaveChanges } from '../../kernel/design-system/row-form';
import { byId, list, useQuery, useRow } from '../../kernel/sync/store';
import { useCanWrite, useMembers } from '../../kernel/identity/session';
import { useT } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, formField } from '../../kernel/design-system/ui/field';
import { chipVariants } from '../../kernel/design-system/ui/chip';
import { pageBody } from '../../kernel/design-system/ui/page';
import { useScopeTargets, useStranded } from './parts';

/** A project's modules. `Editor` is handed in by the route, as it is to `Cycles`. */
export function Modules({ projectId, Editor }: { projectId: string; Editor: typeof MarkdownEditor }) {
  const t = useT();
  const navigate = useNavigate();
  const members = useMembers();
  // This project's own, plus the ones it shares — the same rule, and the same
  // function, the Cycles tab beside it follows.
  const modules = useQuery(() => list('module', (m) => coversProject(m, projectId)), [projectId]);
  /* A sheet rather than the one-line form this used to be. A milestone's scope
     was choosable here and nowhere else, so it could never be changed; moving
     the whole thing into an editor is what gives the warning somewhere to sit,
     and gives the name and the target date one place instead of two. */
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const { confirm, dialog } = useConfirm();
  const canWrite = useCanWrite();

  return (
    <div className={pageBody}>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-title">{t('module.title')}</h2>
        <span className="text-muted text-label">{t('module.subtitle')}</span>
        <span className="flex-1 min-w-0" />
        {canWrite && <Button size="sm" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> {t('module.new')}</Button>}
      </div>

      {!modules.length && <Empty emoji="🎯" title={t('module.emptyTitle')} hint={t('module.emptyHint')} guide="planning" />}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {modules.map((module) => {
          const tasks = list('task', (task) => task.module_id === module.id);
          const done = tasks.filter((task) => isDoneGroup(byId('state', task.state_id)?.group_key)).length;
          const lead = members.find((member) => member.id === module.lead_id);
          return (
            <div className="rounded border border-line bg-raised p-3.5" key={module.id}>
              <div className="flex items-center gap-2 mb-1.5">
                <strong className="flex-1 min-w-0 truncate">{module.name}</strong>
                {/* Said on the card, because deleting a shared module takes it
                    out of every project in it and the menu beside this offers
                    exactly that. Counted when it names some: "Shared" alone
                    leaves the reader to guess whether that is two or twelve. */}
                {!module.project_id && (
                  <span
                    className={chipVariants()}
                    title={module.projects?.length ? t('module.sharedSomeHint') : t('module.sharedHint')}
                  >
                    {module.projects?.length
                      ? t('module.sharedCount', { count: module.projects.length })
                      : t('module.shared')}
                  </span>
                )}
                {lead && <Avatar user={lead} size={20} />}
                {canWrite && (
                  <MenuButton
                    variant="ghost" size="iconSm"
                    label={t('common.moreActions')}
                    items={[
                      { id: 'edit', label: t('action.edit'), onSelect: () => setEditing(module.id) },
                      ...members.map((member) => ({
                        id: member.id, section: t('project.lead'), label: member.name,
                        onSelect: () => update('module', module.id, { lead_id: member.id }),
                      })),
                      { id: 'delete', section: t('module.danger'), label: t('module.delete'), danger: true, onSelect: async () => {
                        if (await confirm(t(module.project_id ? 'module.deleteConfirm' : 'module.deleteSharedConfirm', { name: module.name }))) remove('module', module.id);
                      } },
                    ]}
                  >
                    <Icon name="dots" size={14} />
                  </MenuButton>
                )}
              </div>
              <Progress value={done} total={tasks.length} />
              <div className="flex items-center gap-2 text-muted text-label mt-1.5">
                <span>{done}/{tasks.length}</span>
                <span className="flex-1 min-w-0" />
                {canWrite ? (
                  <Input
                    inputSize="sm" type="date" style={{ width: 150, height: 28 }}
                    value={module.target_date ?? ''}
                    onChange={(event) => update('module', module.id, { target_date: event.target.value || null })}
                  />
                ) : module.target_date && <span>{shortDate(module.target_date)}</span>}
              </div>
              <Button size="sm" block className="mt-2" onClick={() => navigate(`/modules/${module.id}`)}>{t('action.open')}</Button>
            </div>
          );
        })}
      </div>

      {editing && (
        <ModuleEditor
          Editor={Editor}
          projectId={projectId}
          moduleId={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {dialog}
    </div>
  );
}

/**
 * Making a milestone, and changing one — including what it covers.
 *
 * A milestone was the odd one out: its scope was chosen on the inline form that
 * creates it and never again, because it is otherwise edited through a card and
 * a menu, and the warning a re-scope needs has nowhere to sit on a card. So it
 * has a sheet now, for the same fields a cycle's has — the name, the date it is
 * aimed at, what it is for, and who works on it.
 *
 * `update_module` over MCP has always been able to re-scope one and report what
 * it stranded; this is the same move where the caller is a person.
 */
function ModuleEditor({ projectId, moduleId, onClose, Editor }: {
  projectId: string; moduleId?: string; onClose: () => void; Editor: typeof MarkdownEditor;
}) {
  const t = useT();
  const module_ = useRow('module', moduleId);
  const saveChanges = useSaveChanges('module', module_);
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState(module_?.name ?? '');
  const [target, setTarget] = useState(module_?.target_date ?? '');
  const [description, setDescription] = useState(module_?.description ?? '');
  const choice = useScopeChoice(moduleId ? module_ : undefined, projectId);
  const projects = useScopeTargets();
  const stranded = useStranded('module_id', moduleId, choice.settled);

  const save = async () => {
    if (!name.trim() || choice.incomplete) return;
    const fields = { name: name.trim(), target_date: target || null, description: description.trim() ? description : null };
    if (moduleId) {
      if (stranded.length
        && !(await confirm(t('module.scopeStrandConfirm', { count: stranded.length }), t('action.save')))) return;
      saveChanges({ ...fields, ...choice.settled });
    } else {
      create('module', { ...fields, ...choice.settled, status: 'planned', sort_order: orderKey(null, null) });
    }
    onClose();
  };

  return (
    <>
      <Sheet
        title={moduleId ? t('module.edit') : t('module.new')}
        onClose={onClose}
        footer={(
          <Button variant="primary" onClick={() => void save()} disabled={!name.trim() || choice.incomplete}>
            {t('action.save')}
          </Button>
        )}
      >
        <div className={formField}>
          <label htmlFor="m-name">{t('module.name')}</label>
          <Input id="m-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className={formField}>
          <label htmlFor="m-target">{t('module.target')}</label>
          <Input id="m-target" type="date" value={target ?? ''} onChange={(event) => setTarget(event.target.value)} />
        </div>
        <div className={formField}>
          <label htmlFor="m-desc">{t('module.description')}</label>
          <Editor id="m-desc" value={description} minHeight={90} onChange={setDescription} />
        </div>

        <ProjectScopeField
          id="m-scope"
          scope={choice.scope} onScope={choice.setScope}
          picked={choice.picked} onPicked={choice.setPicked}
          projects={projects}
          stranded={stranded}
          labels={{
            legend: t('module.scope'),
            this: t('module.scopeThis'), some: t('module.scopeSome'), all: t('module.scopeAll'),
            thisHint: t('module.scopeThisHint'), someHint: t('module.scopeSomeHint'), allHint: t('module.scopeAllHint'),
            pickOne: t('module.scopePickOne'),
            strandTitle: t('module.scopeStrandTitle', { count: stranded.length }),
            strandMore: t('module.scopeStrandMore', { count: stranded.length - 12 }),
            strandHint: t('module.scopeStrandHint'),
          }}
        />
      </Sheet>
      {dialog}
    </>
  );
}
