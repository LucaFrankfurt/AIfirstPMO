import { useEffect, useRef, useState } from 'react';
import type { Task } from '@kolibri/shared';
import { api } from '../lib/api';
import { relativeTime, shortDate } from '../lib/format';
import { useT } from '../lib/i18n';
import { byId, list, useQuery, useRow } from '../lib/store';
import { createTask, remove, update } from '../lib/mutations';
import { useMe, useMemberMap, useSession } from '../session';
import { Markdown, MarkdownEditor, downscale } from './Markdown';
import { Comments } from './comments';
import { Relations } from './Relations';
import { TaskTime } from './time';
import {
  AssigneePicker, CyclePicker, DateField, LabelChips, LabelPicker, ModulePicker, PriorityPicker, StatePicker, stateOf,
} from './task-parts';
import { Avatar, Empty, Icon, MenuButton, Sheet, StateDot, useConfirm, useToast } from './ui';

export function TaskDetail({ taskId, onClose, onOpen }: { taskId: string; onClose: () => void; onOpen: (task: Task) => void }) {
  const t = useT();
  const task = useRow('task', taskId);
  const me = useMe();
  const { workspaceId } = useSession();
  const members = useMemberMap();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();

  const [title, setTitle] = useState(task?.title ?? '');
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState(task?.description ?? '');
  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const [activity, setActivity] = useState<any[]>([]);
  const [newSubtask, setNewSubtask] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const comments = useQuery(
    () => list('comment', (c) => c.task_id === taskId).sort((a, b) => a.created_at - b.created_at),
    [taskId],
  );
  const attachments = useQuery(() => list('attachment', (a) => a.task_id === taskId), [taskId]);
  const subtasks = useQuery(() => list('task', (t) => t.parent_id === taskId), [taskId]);
  const project = byId('project', task?.project_id);
  const state = task ? stateOf(task) : undefined;

  useEffect(() => {
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
  }, [taskId, task?.title, task?.description]);

  useEffect(() => {
    if (tab !== 'activity') return;
    api.activity(taskId).then(setActivity).catch(() => setActivity([]));
  }, [tab, taskId]);

  if (!task) {
    return (
      <Sheet title={t('task.title')} onClose={onClose} wide>
        <Empty emoji="🔍" title={t('task.gone')} hint={t('task.goneHint')} />
      </Sheet>
    );
  }

  const saveTitle = () => {
    const next = title.trim();
    if (next && next !== task.title) update('task', task.id, { title: next });
  };

  async function uploadFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const payload = await downscale(file);
        await api.upload(workspaceId, payload, file.name, { task_id: task!.id });
      } catch (err) {
        toast(err instanceof Error ? err.message : t('editor.uploadFailed'));
      }
    }
  }

  return (
    <>
      <Sheet
        wide
        onClose={onClose}
        title={
          <span className="row" style={{ gap: 6 }}>
            <StateDot group={state?.group_key} color={state?.color} />
            <span className="mono muted">{task.identifier}</span>
            {project && <span className="muted truncate">· {project.name}</span>}
          </span>
        }
      >
        <input
          className="input"
          style={{ fontSize: 17, fontWeight: 600, border: 'none', padding: '2px 0', marginBottom: 10, background: 'none' }}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />

        <div className="row wrap" style={{ gap: 6, marginBottom: 14 }}>
          <StatePicker task={task} />
          <PriorityPicker task={task} />
          <AssigneePicker task={task} />
          <LabelPicker task={task} />
          <CyclePicker task={task} />
          <ModulePicker task={task} />
          <MenuButton
            className="btn ghost sm"
            items={[
              { id: 'copy', label: t('action.copyLink'), icon: <Icon name="link" size={14} />, onSelect: () => {
                void navigator.clipboard?.writeText(`${location.origin}/t/${task.id}`);
                toast(t('common.copied'));
              } },
              { id: 'archive', label: task.archived ? t('action.unarchive') : t('action.archive'), icon: <Icon name="archive" size={14} />,
                onSelect: () => update('task', task.id, { archived: task.archived ? 0 : 1 }) },
              { id: 'delete', label: t('task.delete'), icon: <Icon name="trash" size={14} />, danger: true, onSelect: async () => {
                if (await confirm(t('task.deleteConfirm', { identifier: task.identifier }))) {
                  remove('task', task.id);
                  onClose();
                }
              } },
            ]}
          >
            <Icon name="dots" size={14} />
          </MenuButton>
        </div>

        <div className="row wrap" style={{ gap: 10, marginBottom: 16 }}>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            <span className="muted">{t('task.due')}</span>
            <DateField label={t('task.due')} value={task.due_date} onChange={(value) => update('task', task.id, { due_date: value })} />
          </label>
          <label className="row" style={{ gap: 6, fontSize: 12.5 }}>
            <span className="muted">{t('task.estimate')}</span>
            <input
              className="input" type="number" min={0} step={1} style={{ width: 84 }}
              value={task.estimate ?? ''}
              onChange={(event) => update('task', task.id, { estimate: event.target.value === '' ? null : Number(event.target.value) })}
            />
          </label>
        </div>

        <TaskTime taskId={task.id} projectId={task.project_id} />

        {/* description */}
        <section style={{ marginBottom: 18 }}>
          {editingDescription ? (
            <>
              <MarkdownEditor value={description} onChange={setDescription} attachTo={{ task_id: task.id }} autoFocus />
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  className="btn primary sm"
                  onClick={() => {
                    update('task', task.id, { description });
                    setEditingDescription(false);
                  }}
                >
                  {t('action.save')}
                </button>
                <button className="btn sm" onClick={() => { setDescription(task.description ?? ''); setEditingDescription(false); }}>
                  {t('action.cancel')}
                </button>
              </div>
            </>
          ) : (
            <div onClick={() => setEditingDescription(true)} style={{ cursor: 'text', minHeight: 40 }}>
              {task.description?.trim()
                ? <Markdown source={task.description} />
                : <span className="muted">{t('task.addDescription')}</span>}
            </div>
          )}
        </section>

        {/* sub-tasks */}
        <section style={{ marginBottom: 18 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>{t('task.subtasks')}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {t('task.subtaskCount', {
                done: subtasks.filter((child) => stateOf(child)?.group_key === 'completed').length,
                total: subtasks.length,
              })}
            </span>
          </div>
          {subtasks.map((child) => (
            <div key={child.id} className="row" style={{ padding: '5px 0', borderTop: '1px solid var(--line)' }}>
              <StateDot group={stateOf(child)?.group_key} color={stateOf(child)?.color} />
              <button className="btn ghost sm grow" style={{ justifyContent: 'flex-start' }} onClick={() => onOpen(child)}>
                <span className="mono muted">{child.identifier}</span>
                <span className="truncate">{child.title}</span>
              </button>
            </div>
          ))}
          <form
            className="row"
            style={{ marginTop: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!newSubtask.trim()) return;
              createTask({ project_id: task.project_id, title: newSubtask, parent_id: task.id }, me);
              setNewSubtask('');
            }}
          >
            <input className="input" placeholder={t('task.addSubtask')} value={newSubtask} onChange={(e) => setNewSubtask(e.target.value)} />
            <button className="btn sm" type="submit"><Icon name="plus" size={14} /></button>
          </form>
        </section>

        <Relations task={task} onOpen={onOpen} />

        {/* attachments */}
        <section style={{ marginBottom: 18 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>{t('task.files')}</strong>
            <span className="grow" />
            <button className="btn ghost sm" onClick={() => fileInput.current?.click()}>
              <Icon name="attach" size={14} /> {t('task.attach')}
            </button>
            <input
              ref={fileInput} type="file" hidden multiple
              onChange={(event) => {
                void uploadFiles([...(event.target.files ?? [])]);
                event.target.value = '';
              }}
            />
          </div>
          {attachments.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>{t('task.noFiles')}</span>}
          <div className="col" style={{ gap: 6 }}>
            {attachments.map((file) => (
              <a className="attachment" key={file.id} href={file.url} target="_blank" rel="noreferrer">
                {file.mime?.startsWith('image/') ? <img src={file.url} alt="" /> : <Icon name="page" />}
                <span className="grow truncate">{file.name}</span>
                <span className="muted">{Math.max(1, Math.round((file.size ?? 0) / 1024))} KB</span>
              </a>
            ))}
          </div>
        </section>

        {/* discussion */}
        <section>
          <div className="tabs" style={{ marginBottom: 10 }}>
            <button className={tab === 'comments' ? 'active' : ''} onClick={() => setTab('comments')}>
              {t('task.comments')} {comments.length ? `(${comments.length})` : ''}
            </button>
            <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>{t('task.activity')}</button>
          </div>

          {tab === 'comments' ? (
            <Comments target={{ task_id: task.id }} />
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {activity.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>{t('task.noActivity')}</span>}
              {activity.map((entry) => (
                <div key={entry.id} className="row" style={{ fontSize: 12.5, gap: 7 }}>
                  <Avatar user={members.get(entry.actor_id)} size={18} />
                  <span className="soft grow">
                    <strong>{members.get(entry.actor_id)?.name ?? t('common.someone')}</strong>{' '}
                    {entry.verb === 'created'
                      ? t('task.activityCreated')
                      : t('task.activityChanged', { field: entry.field?.replace('_id', '') ?? t('task.activitySomething') })}
                  </span>
                  <span className="muted">{relativeTime(entry.created_at)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="muted" style={{ fontSize: 11.5, marginTop: 18 }}>
          {t('task.createdUpdated', { created: shortDate(task.created_at), updated: relativeTime(task.updated_at) })}
          {task.labels?.length ? <span className="row wrap" style={{ marginTop: 6 }}><LabelChips ids={task.labels} projectId={task.project_id} /></span> : null}
        </div>
      </Sheet>
      {dialog}
    </>
  );
}
