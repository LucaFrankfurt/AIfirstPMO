/**
 * Every primitive the client is built from, in each of its states, on one page.
 *
 * It exists for the browser checks as much as for people. A primitive used to
 * be measured only where a screen happened to use it, in whichever state that
 * screen happened to show: the tonal button was checked on a white page and
 * never on the frame, a disabled field never at all, a danger chip only if the
 * seed had made one. Here each of them appears once, side by side, and
 * `check:contrast`, `check:a11y` and `check:responsive` walk this page in light
 * and dark, on a phone and a desktop. A primitive that stops being readable
 * fails here before it fails on a screen somebody depends on.
 *
 * It is reached by its address only (`/design`), which `reachable.test.ts`
 * says, and it shows no workspace data — only the words the app already has.
 *
 * What it does not do is compare pixels with yesterday. A screenshot baseline
 * is only stable inside one browser build and one set of fonts, which is the
 * CI image and not the machine somebody changes a button on; recording it
 * there and comparing against it is the next step, and it is not taken here.
 */
import { useState, type ReactNode } from 'react';
import type { Priority, StateGroup } from '@kolibri/shared';
import { useT } from '../../i18n/i18n';
import { useTabStrip } from '../tab-strip';
import { Header } from '../chrome';
import { Avatar, AvatarStack } from '../ui/avatar';
import { Button } from '../ui/button';
import { Chip, chipDot } from '../ui/chip';
import { Empty } from '../ui/empty';
import { Input, Label, Select, Textarea } from '../ui/field';
import { Icon } from '../ui/icon';
import { PriorityBars, StateDot } from '../ui/marks';
import { MenuButton } from '../ui/menu-button';
import { Progress } from '../ui/progress';
import { SectionHeading } from '../ui/section';
import { Segmented, SegmentedItem } from '../ui/segmented';
import { floatingSurface } from '../ui/surface';
import { TabButton, TabList } from '../ui/tabs';
import { snackbar, useToast } from '../ui/toast';
import { Tooltip } from '../ui/tooltip';
import { cn } from '../cn';
import { pageBody } from '../../../kernel/design-system/ui/page';

const GROUPS: StateGroup[] = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];
const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const PEOPLE = [
  { id: 'catalogue-ada', name: 'Ada Lovelace' },
  { id: 'catalogue-grace', name: 'Grace Hopper' },
  { id: 'catalogue-alan', name: 'Alan Turing' },
  { id: 'catalogue-margaret', name: 'Margaret Hamilton' },
];
// Written out in full: Tailwind generates a class only if its whole name is in the source.
const STEPS = [
  ['caption', 'text-caption'], ['label', 'text-label'], ['body', 'text-body'],
  ['title', 'text-title'], ['headline', 'text-headline'], ['display', 'text-display'],
] as const;
const SURFACES = ['bg', 'sunken', 'raised', 'hover', 'active', 'fill', 'accent-soft'] as const;

/** A row of specimens under a caption. Wraps, so a phone sees all of them. */
function Row({ components, children }: { components: string; children: ReactNode }) {
  // The caption is the components' names as the code spells them: an
  // identifier, shown as code, and the same in every language.
  return (
    <div className="flex flex-col gap-2 py-3">
      <code className="text-label text-muted">{components}</code>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function DesignCatalog() {
  const t = useT();
  const toast = useToast();
  const [layout, setLayout] = useState<'list' | 'board' | 'table'>('list');
  const [tab, setTab] = useState(0);
  const strip = useTabStrip(tab);

  return (
    <>
      <Header title={t('design.title')} />
      <div className={pageBody}>
        <p className="max-w-[60ch] text-body text-soft">{t('design.intro')}</p>

        <SectionHeading>{t('design.buttons')}</SectionHeading>
        <Row components="primary · secondary · ghost · danger · link">
          <Button variant="primary"><Icon name="plus" size={14} />{t('nav.newTask')}</Button>
          <Button><Icon name="filter" size={14} />{t('view.filter')}</Button>
          <Button variant="ghost">{t('view.display')}</Button>
          <Button variant="danger">{t('action.delete')}</Button>
          <Button variant="link">{t('action.cancel')}</Button>
        </Row>
        <Row components="sm · lg · icon · disabled">
          <Button size="sm">{t('action.save')}</Button>
          <Button size="lg" variant="primary">{t('action.save')}</Button>
          <Button size="icon" title={t('action.archive')}><Icon name="archive" /></Button>
          <Button size="iconSm" variant="ghost" title={t('action.close')}><Icon name="close" /></Button>
          <Button disabled>{t('action.save')}</Button>
          <Button variant="primary" disabled>{t('action.save')}</Button>
        </Row>

        <SectionHeading>{t('design.chips')}</SectionHeading>
        <Row components="default · on">
          <Chip><span className={chipDot} style={{ background: 'var(--chart-2)' }} />{t('view.list')}</Chip>
          <Chip tone="on">{t('view.board')}</Chip>
        </Row>

        <SectionHeading>{t('design.choices')}</SectionHeading>
        <Row components="Segmented">
          <Segmented aria-label={t('design.choices')}>
            {(['list', 'board', 'table'] as const).map((value) => (
              <SegmentedItem key={value} pressed={layout === value} onClick={() => setLayout(value)}>
                <Icon name={value} size={14} />{t(`view.${value}`)}
              </SegmentedItem>
            ))}
          </Segmented>
        </Row>
        <Row components="Tabs">
          <TabList ref={strip} className="tabs" aria-label={t('design.choices')}>
            {(['list', 'board', 'table'] as const).map((value, at) => (
              <TabButton key={value} active={tab === at} onClick={() => setTab(at)}>{t(`view.${value}`)}</TabButton>
            ))}
          </TabList>
        </Row>

        <SectionHeading>{t('design.fields')}</SectionHeading>
        <div className="grid gap-3 py-3 sm:grid-cols-2">
          <Label label={t('design.fieldLabel')} hint={t('design.fieldHint')}>
            <Input defaultValue={t('design.sample')} />
          </Label>
          <Label label={t('design.fieldLabel')} hint={t('design.fieldInvalid')}>
            <Input aria-invalid="true" defaultValue="ada@" />
          </Label>
          <Label label={t('design.fieldLabel')}>
            <Select defaultValue="board">
              {(['list', 'board', 'table'] as const).map((value) => <option key={value} value={value}>{t(`view.${value}`)}</option>)}
            </Select>
          </Label>
          <Label label={t('design.fieldLabel')}>
            <Input disabled defaultValue={t('design.sample')} />
          </Label>
          <Label label={t('design.fieldLabel')} className="sm:col-span-2">
            <Textarea defaultValue={t('design.sample')} />
          </Label>
        </div>

        <SectionHeading>{t('design.floating')}</SectionHeading>
        <Row components="MenuButton · Tooltip">
          <MenuButton
            items={[
              { id: 'filter', label: t('view.filter'), icon: <Icon name="filter" size={14} /> },
              { id: 'display', label: t('view.display'), icon: <Icon name="sliders" size={14} /> },
              { id: 'delete', label: t('action.delete'), icon: <Icon name="trash" size={14} />, danger: true },
            ]}
            variant="secondary"
          >
            <Icon name="dots" size={14} />{t('view.display')}
          </MenuButton>
          <Tooltip label={t('action.archive')}>
            <Button size="icon" variant="ghost" title={t('action.archive')}><Icon name="archive" /></Button>
          </Tooltip>
        </Row>
        {/* The menu's surface at rest, over a line of text, so the checks can
            measure the glass without having to open anything. */}
        <div className="relative py-3">
          <p className="m-0 text-headline text-fg" aria-hidden="true">{t('design.sample')}</p>
          <div className={cn(floatingSurface, 'absolute inset-x-0 top-5 mx-auto w-[min(18rem,100%)] p-1')}>
            {([['filter', t('view.filter')], ['sliders', t('view.display')], ['archive', t('action.archive')]] as const).map(([icon, words]) => (
              <div key={icon} className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-body">
                <Icon name={icon} size={14} />{words}
                <span className="ms-auto text-label text-muted">{t('design.fieldHint')}</span>
              </div>
            ))}
          </div>
          <div className="h-24" />
        </div>

        <SectionHeading>{t('design.feedback')}</SectionHeading>
        <Row components="Snackbar · Progress">
          <div className={snackbar} role="presentation">{t('design.sample')}</div>
          <Button size="sm" onClick={() => toast(t('design.sample'))}>{t('design.showToast')}</Button>
          <Progress value={3} total={5} className="w-48" />
        </Row>
        <Empty emoji="🌱" title={t('design.emptyTitle')} hint={t('design.emptyHint')} />

        <SectionHeading>{t('design.people')}</SectionHeading>
        <Row components="Avatar · AvatarStack">
          {PEOPLE.map((person) => <Avatar key={person.id} user={person} size={28} />)}
          <AvatarStack users={PEOPLE} size={24} />
        </Row>
        <Row components="StateDot · PriorityBars">
          {GROUPS.map((group) => <StateDot key={group} group={group} />)}
          {PRIORITIES.map((priority) => <PriorityBars key={priority} priority={priority} />)}
        </Row>

        <SectionHeading>{t('design.type')}</SectionHeading>
        <div className="flex flex-col gap-1 py-3">
          {STEPS.map(([step, size]) => (
            <div key={step} className="flex flex-wrap items-baseline gap-x-4">
              <code className="w-28 shrink-0 text-label text-muted">{size}</code>
              <span className={cn(size, 'min-w-0')}>{t('design.sample')}</span>
            </div>
          ))}
        </div>

        <SectionHeading>{t('design.surfaces')}</SectionHeading>
        <div className="grid grid-cols-2 gap-2 py-3 sm:grid-cols-4 lg:grid-cols-7">
          {SURFACES.map((surface) => (
            <div key={surface} className="flex h-20 flex-col justify-end rounded border border-line p-2" style={{ background: `var(--${surface === 'bg' ? 'bg' : surface === 'accent-soft' ? 'accent-soft' : `bg-${surface}`})` }}>
              <code className={cn('text-label', surface === 'accent-soft' ? 'text-accent' : 'text-soft')}>{surface}</code>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
