/**
 * Settings → Widgets: the chat windows this workspace puts on other sites.
 *
 * An administrator's screen, because a widget decides who outside the
 * workspace may write into it. The server refuses anybody else; this keeps
 * the screen from offering what would only answer 403.
 */
import { useEffect, useState } from 'react';
import {
  WIDGET_ASSISTANTS, WIDGET_IDENTITIES, cleanOrigins, isWidgetColor, widgetSnippet,
  type Widget, type WidgetAssistant, type WidgetIdentity,
} from '@kolibri/shared';
import { Empty, Icon, Sheet, useAction, useConfirm, useToast } from '../../kernel/design-system/ui';
import { Button } from '../../kernel/design-system/ui/button';
import { Chip } from '../../kernel/design-system/ui/chip';
import { Input, Label, Select, Textarea } from '../../kernel/design-system/ui/field';
import { SectionHeading } from '../../kernel/design-system/ui/section';
import { useT } from '../../kernel/i18n/i18n';
import { useFeature, useMembers, useRunsWorkspace } from '../../kernel/identity/session';
import { api } from '../../kernel/sync/api';
import { create, remove, update } from '../../kernel/sync/mutations';
import { serverOrigin } from '../../kernel/sync/server';
import { list, useQuery } from '../../kernel/sync/store';

const ASSISTANT_LABEL = { off: 'widgets.assistantOff', suggest: 'widgets.assistantSuggest', answer: 'widgets.assistantAnswer' } as const;
const ASSISTANT_HINT = { off: 'widgets.assistantOffHint', suggest: 'widgets.assistantSuggestHint', answer: 'widgets.assistantAnswerHint' } as const;

/** Where this instance answers, for the snippet: the packaged app knows it; a browser is on it. */
const publicUrl = (): string => serverOrigin() || window.location.origin;

const listOf = <T,>(value: unknown): T[] => (Array.isArray(value) ? value : []);

export function WidgetSettings() {
  const t = useT();
  const runs = useRunsWorkspace();
  const widgets = useQuery(() => list('widget').sort((a, b) => a.name.localeCompare(b.name)), []);
  const [editing, setEditing] = useState<Widget | 'new' | null>(null);

  if (!runs) return <p className="text-muted">{t('widgets.adminsOnly')}</p>;

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <p className="m-0 flex-1 text-[12.5px] text-muted">{t('widgets.intro')}</p>
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>{t('widgets.new')}</Button>
      </div>
      {!widgets.length && <Empty emoji="💬" title={t('widgets.none')} hint={t('widgets.noneHint')} />}
      <div className="flex flex-col gap-3">
        {widgets.map((widget) => <WidgetCard key={widget.id} widget={widget} onEdit={() => setEditing(widget)} />)}
      </div>
      {editing && <WidgetSheet widget={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function WidgetCard({ widget, onEdit }: { widget: Widget; onEdit: () => void }) {
  const t = useT();
  const toast = useToast();
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const [secret, setSecret] = useState('');
  const snippet = widgetSnippet(publicUrl(), widget.id, widget.identity, widget.color);
  const origins = listOf<string>(widget.origins);

  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(t('widgets.copied')));

  return (
    <section className="rounded-[var(--radius)] border border-line bg-raised p-4" style={widget.color ? { borderTopColor: widget.color, borderTopWidth: 3 } : undefined}>
      <div className="mb-2 flex items-center gap-2">
        <strong className="min-w-0 flex-1 truncate">{widget.name || t('widgets.unnamed')}</strong>
        <Chip className="h-6 leading-6" tone={widget.enabled ? 'on' : 'default'}>
          {t(widget.enabled ? 'widgets.live' : 'widgets.paused')}
        </Chip>
        <Button size="sm" onClick={onEdit}>{t('action.edit')}</Button>
      </div>
      <p className="m-0 mb-2 text-[12.5px] text-muted">
        {t(widget.identity === 'signed' ? 'widgets.signedSummary' : 'widgets.anonymousSummary')}
        {' · '}
        {origins.length ? origins.join(', ') : t('widgets.noSites')}
      </p>

      <SectionHeading>{t('widgets.snippet')}</SectionHeading>
      <pre className="m-0 mb-2 whitespace-pre-wrap break-all rounded-[var(--radius-sm)] bg-sunken p-3 font-mono text-[12px] leading-[1.5]">{snippet}</pre>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => copy(snippet)}>{t('widgets.copySnippet')}</Button>
        <Button size="sm" variant="ghost" onClick={() => window.open(`${publicUrl()}/w/${widget.id}`, '_blank', 'noopener')}>
          {t('widgets.preview')}
        </Button>
      </div>

      {widget.identity === 'signed' && (
        <>
          <SectionHeading>{t('widgets.secret')}</SectionHeading>
          <p className="m-0 mb-2 text-[12.5px] text-muted">{t('widgets.secretHint')}</p>
          {secret && <pre className="m-0 mb-2 whitespace-pre-wrap break-all rounded-[var(--radius-sm)] bg-sunken p-3 font-mono text-[12px]">{secret}</pre>}
          <div className="flex flex-wrap gap-2">
            {secret
              ? <Button size="sm" onClick={() => copy(secret)}>{t('widgets.copySecret')}</Button>
              : (
                <Button size="sm" disabled={action.busy} onClick={() => action.run(async () => {
                  setSecret((await api.get<{ secret: string }>(`/api/widgets/${widget.id}/secret`)).secret);
                })}>{t('widgets.reveal')}</Button>
              )}
            <Button size="sm" variant="danger" disabled={action.busy} onClick={async () => {
              if (!await confirm(t('widgets.rotateConfirm'), t('widgets.rotate'))) return;
              await action.run(async () => {
                setSecret((await api.post<{ secret: string }>(`/api/widgets/${widget.id}/secret`, {})).secret);
                toast(t('widgets.rotated'));
              });
            }}>{t('widgets.rotate')}</Button>
          </div>
        </>
      )}
      {dialog}
    </section>
  );
}

function WidgetSheet({ widget, onClose }: { widget: Widget | null; onClose: () => void }) {
  const t = useT();
  const members = useMembers();
  const projects = useQuery(() => list('project', (project) => !project.archived).sort((a, b) => a.name.localeCompare(b.name)), []);
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState(widget?.name ?? '');
  const [projectId, setProjectId] = useState(widget?.project_id ?? projects[0]?.id ?? '');
  const [identity, setIdentity] = useState<WidgetIdentity>(widget?.identity ?? 'signed');
  const [sites, setSites] = useState(listOf<string>(widget?.origins).join('\n'));
  const [greeting, setGreeting] = useState(widget?.greeting ?? '');
  const [color, setColor] = useState(widget?.color ?? '');
  const [agents, setAgents] = useState<string[]>(listOf<string>(widget?.agents));
  const [enabled, setEnabled] = useState(widget ? !!widget.enabled : true);
  // Read defensively: a widget synced before these columns existed has none of them.
  const [replyTo, setReplyTo] = useState(widget?.reply_to ?? '');
  const [assistant, setAssistant] = useState<WidgetAssistant>(widget?.assistant ?? 'off');
  const [knowledge, setKnowledge] = useState<string[]>(listOf<string>(widget?.knowledge));
  const [budget, setBudget] = useState(String(widget?.assistant_budget ?? 50));
  const aiSwitch = useFeature('ai');
  const [modelOn, setModelOn] = useState(true);
  useEffect(() => { api.config().then((config) => setModelOn(!!config.ai)).catch(() => setModelOn(false)); }, []);
  // Only pages in the public knowledge base are offered: the model reads no
  // other, and offering one would be offering a page it then quietly skips.
  const pages = useQuery(
    () => list('page', (page) => !page.archived && page.access !== 'private')
      .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '')),
    [],
  );
  const offered = pages.filter((page) => Number(page.public_knowledge) === 1);
  const titleOf = new Map(pages.map((page) => [page.id, page.title || t('widgets.untitledPage')]));
  // Chosen before the mark existed, or unmarked since: kept in the list, and
  // said to be unread, so removing the mark never silently empties a widget.
  const unread = new Set(knowledge.filter((id) => !offered.some((page) => page.id === id)));

  const origins = cleanOrigins(sites);
  const typed = sites.split(/[\s,]+/).filter(Boolean);
  const dropped = typed.length - origins.length;
  const valid = !!name.trim() && !!projectId;

  const save = () => {
    const values = {
      name: name.trim(), project_id: projectId, identity, origins, greeting: greeting.trim() || null,
      color: isWidgetColor(color) ? color : null, agents, enabled: enabled ? 1 : 0,
      reply_to: replyTo.trim() || null,
      assistant, knowledge, assistant_budget: Math.max(0, Math.round(Number(budget) || 0)),
    };
    if (widget) update('widget', widget.id, values);
    else create('widget', values);
    onClose();
  };

  return (
    <Sheet
      title={widget ? t('widgets.edit') : t('widgets.new')}
      onClose={onClose}
      footer={(
        <>
          {widget && (
            <Button variant="danger" className="mr-auto" onClick={async () => {
              if (!await confirm(t('widgets.deleteConfirm'))) return;
              remove('widget', widget.id);
              onClose();
            }}>{t('action.delete')}</Button>
          )}
          <Button onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" disabled={!valid} onClick={save}>{t('action.save')}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3.5">
        <Label label={t('widgets.name')} hint={t('widgets.nameHint')}>
          <Input value={name} autoFocus onChange={(event) => setName(event.target.value)} />
        </Label>
        <Label label={t('widgets.project')} hint={t('widgets.projectHint')}>
          <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </Select>
        </Label>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-[13px] font-medium">{t('widgets.identity')}</legend>
          {WIDGET_IDENTITIES.map((option) => (
            <label key={option} className="check-row">
              <input type="radio" name="identity" checked={identity === option} onChange={() => setIdentity(option)} />
              <span>
                <span>{t(option === 'signed' ? 'widgets.signed' : 'widgets.anonymous')}</span>
                <span className="text-[12px] text-muted">{t(option === 'signed' ? 'widgets.signedHint' : 'widgets.anonymousHint')}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Label label={t('widgets.sites')} hint={t('widgets.sitesHint')}>
          <Textarea rows={3} value={sites} placeholder={'example.com\ndev.example.com'} onChange={(event) => setSites(event.target.value)} />
        </Label>
        {dropped > 0 && <p className="m-0 text-[12px] text-warn">{t('widgets.sitesDropped', { count: dropped })}</p>}
        <Label label={t('widgets.greeting')} hint={t('widgets.greetingHint')}>
          <Textarea rows={2} maxLength={500} value={greeting} onChange={(event) => setGreeting(event.target.value)} />
        </Label>
        <Label label={t('widgets.color')} hint={t('widgets.colorHint')}>
          <span className="flex items-center gap-2">
            <input type="color" value={isWidgetColor(color) ? color : '#4f46e5'} aria-label={t('widgets.color')} onChange={(event) => setColor(event.target.value)} />
            {isWidgetColor(color) && <Button size="sm" variant="ghost" onClick={() => setColor('')}>{t('widgets.defaultColor')}</Button>}
          </span>
        </Label>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-[13px] font-medium">{t('widgets.agents')}</legend>
          <span className="text-[12px] text-muted">{t('widgets.agentsHint')}</span>
          {members.map((member) => (
            <label key={member.id} className="check-row">
              <input
                type="checkbox"
                checked={agents.includes(member.id)}
                onChange={(event) => setAgents((now) => (event.target.checked ? [...now, member.id] : now.filter((one) => one !== member.id)))}
              />
              <span>{member.name}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-[13px] font-medium">{t('widgets.assistant')}</legend>
          {WIDGET_ASSISTANTS.map((option) => (
            <label key={option} className="check-row">
              <input type="radio" name="assistant" checked={assistant === option} onChange={() => setAssistant(option)} />
              <span>
                <span>{t(ASSISTANT_LABEL[option])}</span>
                <span className="text-[12px] text-muted">{t(ASSISTANT_HINT[option])}</span>
              </span>
            </label>
          ))}
          {assistant !== 'off' && !(modelOn && aiSwitch) && (
            <p className="m-0 text-[12px] text-warn">{t('widgets.assistantNeeds')}</p>
          )}
        </fieldset>
        {assistant !== 'off' && (
          <>
            <Label label={t('widgets.knowledge')} hint={t('widgets.knowledgeHint')}>
              <Select value="" disabled={!offered.length} onChange={(event) => event.target.value && setKnowledge((now) => [...now, event.target.value])}>
                <option value="">{t('widgets.knowledgeAdd')}</option>
                {offered.filter((page) => !knowledge.includes(page.id)).map((page) => (
                  <option key={page.id} value={page.id}>{page.title || t('widgets.untitledPage')}</option>
                ))}
              </Select>
            </Label>
            {!offered.length && <p className="m-0 text-[12px] text-muted">{t('widgets.knowledgeNone')}</p>}
            {knowledge.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {knowledge.map((id) => (
                  <Chip key={id} className="h-7 leading-7" title={unread.has(id) ? t('widgets.notPublic') : undefined}>
                    {unread.has(id) && <Icon name="alert" size={12} className="text-warn" />}
                    <span className={`max-w-[200px] truncate${unread.has(id) ? ' line-through text-muted' : ''}`}>{titleOf.get(id) ?? t('widgets.untitledPage')}</span>
                    <button type="button" aria-label={t('action.remove')} onClick={() => setKnowledge((now) => now.filter((one) => one !== id))}>×</button>
                  </Chip>
                ))}
              </div>
            )}
            {unread.size > 0 && <p className="m-0 text-[12px] text-warn">{t('widgets.notPublic')}</p>}
            {assistant === 'answer' && (
              <Label label={t('widgets.budget')} hint={t('widgets.budgetHint')}>
                <Input type="number" min={0} max={10000} value={budget} onChange={(event) => setBudget(event.target.value)} />
              </Label>
            )}
          </>
        )}
        <Label label={t('widgets.replyTo')} hint={t('widgets.replyToHint')}>
          <Input type="email" value={replyTo} placeholder="support@example.com" onChange={(event) => setReplyTo(event.target.value)} />
        </Label>
        <label className="check-row">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>
            <span>{t('widgets.enabled')}</span>
            <span className="text-[12px] text-muted">{t('widgets.enabledHint')}</span>
          </span>
        </label>
      </div>
      {dialog}
    </Sheet>
  );
}
