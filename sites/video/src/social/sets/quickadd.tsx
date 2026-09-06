/**
 * The quick-add syntax, one sigil to a slide.
 *
 * This is the set that justifies the format. A film shows the line being typed
 * and parsed, which is the right way to *sell* the feature and a useless way to
 * *learn* it — nobody pauses a reel to read a vocabulary. A carousel is kept:
 * screenshotted, saved, come back to. So this one is aimed at somebody who has
 * already installed Kolibri, and every word on it is quoted from
 * `packages/shared/src/modules/work/quickadd.ts` rather than summarised from it.
 *
 * Each card's tint is the tint `QuickAddField` gives that token, so the sigil is
 * the same colour on the slide that teaches it as on the slide that shows the
 * whole line. That is the only reason those five colours are repeated here.
 */
import { colour } from '../../theme';
import { quickAdd } from '../../product';
import { QuickAddField } from '../../components/QuickAddField';
import { TaskCard } from '../../components/ui';
import { Sigil } from '../Sigil';
import type { Carousel } from '../slide';

const W = 912;

/**
 * One height for all six cards, not each one's own.
 *
 * They are read as a set — swiped through in a row — and a box that fits each
 * card exactly puts the sigil at six different heights, because the priority
 * card has nine values and the assignee card has three. 460 is the tallest of
 * them (the date card, which has the long note), so every card starts on the
 * same line and only the space under it varies, where nobody is looking.
 */
const CARD = 460;

export const quickadd: Carousel = {
  id: 'SocialQuickAdd',
  about: 'the quick-add syntax — a reference card per sigil, for somebody who already has it running',
  slides: [
    {
      kind: 'cover',
      kicker: 'Quick add',
      headline: 'A whole task on one line.',
      sub: 'Six sigils, and one rule about the words that are not sigils. Save this one.',
      chips: ['!high', '@name', '#PROJECT', '*label', 'due:', 'every:'],
      mono: true,
    },
    {
      kind: 'point',
      kicker: 'The line',
      headline: 'Type it, and it is a task.',
      sub: 'Every sigil the vocabulary recognises becomes a field. Everything else is the title.',
      visual: {
        height: 370,
        node: (
          <>
            <QuickAddField frame={140} width={W} size={24} style={{ left: 0, top: 0 }} />
            <div style={{ position: 'absolute', left: 76, top: 215 }}>
              <TaskCard
                id="WEB-2"
                title="Redraw the empty state"
                priority={3}
                chips={[
                  { label: 'High', dot: colour.danger },
                  { label: 'Website', dot: colour.accent },
                  { label: 'design', dot: colour.brand },
                  { label: 'Sep 11' },
                ]}
                avatar={{ initials: 'AL', fill: colour.ok }}
                width={760}
              />
            </div>
          </>
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Priority',
      headline: 'Four levels, or the numbers.',
      visual: {
        height: CARD,
        node: (
          <Sigil
            width={W}
            sigil="!high"
            field="priority"
            tint={colour.danger}
            accepts={['!urgent', '!high', '!medium', '!low', '!none', '!1', '!2', '!3', '!4']}
            note="!1 is the urgent one, the way every tool that numbers them does it. The words are read in German and French too."
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Assignee',
      headline: 'Anyone by name, or yourself.',
      visual: {
        height: CARD,
        node: (
          <Sigil
            width={W}
            sigil="@ada"
            field="assignee"
            tint={colour.ok}
            accepts={['@ada', '@me', '@"Ada Lovelace"']}
            note="Quote a name that has a space in it. More than one @ means more than one assignee."
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Project',
      headline: 'By key, or by name.',
      visual: {
        height: CARD,
        node: (
          <Sigil
            width={W}
            sigil="#WEB"
            field="project"
            tint={colour.accent}
            accepts={['#WEB', '#Website', '#"Public API"']}
            note="The key is the half of the identifier you say out loud — the WEB in WEB-6."
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Label',
      headline: 'As many as you type.',
      visual: {
        height: CARD,
        node: (
          <Sigil
            width={W}
            sigil="*design"
            field="label"
            tint={colour.brand}
            accepts={['*design', '*bug', '*"needs copy"']}
            note="A label the workspace does not have stays in the title. Nothing is invented, and nothing is silently dropped."
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Due date',
      headline: 'A weekday always means the next one.',
      visual: {
        height: CARD,
        node: (
          <Sigil
            width={W}
            sigil="due:friday"
            field="due date"
            tint={colour.warn}
            accepts={['due:today', 'due:tomorrow', 'due:friday', 'due:2026-09-11', '+3d', '+2w']}
            note="due:friday typed on a Friday is next Friday. The prefix is not optional — a bare monday in the middle of a sentence is a word, and a task called “Meeting” with the day eaten out of it is worse than two characters of typing."
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'Recurrence',
      headline: 'Daily, weekly, monthly — or every second one.',
      visual: {
        height: CARD,
        node: (
          <Sigil
            width={W}
            sigil="every:weekly"
            field="recurrence"
            tint={colour.info}
            accepts={['every:daily', 'every:weekly', 'every:monthly', 'every:2w', 'repeat:weekly']}
            note="repeat: is the same sigil under a second name, because half the people who look for it look for that one."
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'The rule',
      headline: 'A token nothing answers to stays in the title.',
      sub: '“!important” is a word and “!urgent” is a priority, and the only difference is whether the vocabulary recognises it. A token deleted because it looked like a sigil is worse than one left where it was typed.',
      code: 'Ship the !important fix !urgent\n→  title "Ship the !important fix" · priority urgent',
    },
    {
      kind: 'close',
      kicker: 'Quick add',
      headline: 'One field, on every screen that has a task on it.',
      sub: 'And the same parser behind the MCP create_task tool, so an assistant files a task the way you do.',
      code: quickAdd.syntax,
    },
  ],
};
