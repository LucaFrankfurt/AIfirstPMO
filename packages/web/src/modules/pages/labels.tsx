/**
 * The workspace's own labels, and what each may be put on.
 *
 * A label belonged to a project or to the whole workspace, and either way it
 * was offered on tasks and pages alike — so the wiki's topics and the
 * tracker's `Bug` came out of one list. `applies_to` splits them, and this is
 * where a workspace says which is which for the labels that belong to no
 * project: a page in no project is offered exactly these (`labelsForPage`).
 *
 * Before this screen there was no way to make a workspace-wide label from the
 * app at all — only over MCP, or by accident. So a wiki that wanted a topic
 * label had to borrow one from some project's list.
 */
import { useState } from 'react';
import { scopeOf, LABEL_SCOPES, type Label, type LabelScope } from '@kolibri/shared';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { create, remove, update } from '../../kernel/sync/mutations';
import { list, useQuery } from '../../kernel/sync/store';
import { useCanWrite, useSession } from '../../kernel/identity/session';
import { Icon } from '../../kernel/design-system/ui/icon';
import { useConfirm } from '../../kernel/design-system/ui/sheet';
import { Button } from '../../kernel/design-system/ui/button';
import { Input, Select } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';

/** What each scope is called where somebody is choosing one. */
export const SCOPE_KEY: Record<LabelScope, TranslationKey> = {
  all: 'labels.scopeAll', tasks: 'labels.scopeTasks', pages: 'labels.scopePages',
};

export function WorkspaceLabelSettings() {
  const t = useT();
  const { workspaceId } = useSession();
  const canWrite = useCanWrite();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState('');
  const labels = useQuery(
    () => (list('label', (label) => label.workspace_id === workspaceId && !label.project_id) as Label[])
      .sort((a, b) => a.name.localeCompare(b.name)),
    [workspaceId],
  );
  if (!canWrite) return null;

  return (
    <>
      <div className="flex items-center gap-2" style={{ margin: '18px 0 8px' }}>
        <SectionHeading tight>{t('labels.workspace')}</SectionHeading>
      </div>
      <p className="mt-0 mb-2.5 text-label text-muted">{t('labels.workspaceHint')}</p>
      {labels.map((label) => (
        <div className="stack-card" key={label.id}>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="color" value={label.color} style={{ width: 28, height: 28, border: 'none', background: 'none' }}
              aria-label={t('labels.colour')}
              onChange={(event) => update('label', label.id, { color: event.target.value })}
            />
            <Input
              className="flex-1 min-w-0" value={label.name} aria-label={t('labels.name')}
              onChange={(event) => update('label', label.id, { name: event.target.value })}
            />
            <Select
              value={scopeOf(label)} aria-label={t('labels.scope')}
              onChange={(event) => update('label', label.id, { applies_to: event.target.value })}
            >
              {LABEL_SCOPES.map((scope) => <option key={scope} value={scope}>{t(SCOPE_KEY[scope])}</option>)}
            </Select>
            <Button
              variant="ghost" size="icon" aria-label={t('labels.delete')}
              onClick={async () => {
                if (await confirm(t('project.deleteLabelConfirm', { name: label.name }))) remove('label', label.id);
              }}
            >
              <Icon name="trash" size={14} />
            </Button>
          </div>
        </div>
      ))}
      <form
        className="flex items-center gap-2 mt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          // A label made here is a topic for the wiki unless somebody says
          // otherwise: that is the gap this screen exists to close, and a
          // task label still has its project's list.
          create('label', { workspace_id: workspaceId, project_id: null, name: name.trim(), color: '#6366f1', applies_to: 'pages' });
          setName('');
        }}
      >
        <Input placeholder={t('labels.new')} aria-label={t('labels.new')} value={name} onChange={(event) => setName(event.target.value)} />
        <Button type="submit" variant="secondary" size="sm"><Icon name="plus" size={14} /> {t('labels.add')}</Button>
      </form>
      {dialog}
    </>
  );
}
