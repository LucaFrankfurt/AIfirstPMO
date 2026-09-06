/**
 * The six levels, and the two rules that keep them honest.
 *
 * The shape of a work tracker is the thing somebody has to hold in their head
 * before they can use it, and it is the thing a thirty-second film is worst at:
 * the tree beat builds nine rows in seven seconds and a viewer gets the gist
 * and not the shape. Here they can stop on it.
 *
 * Both rules are quotations, not paraphrases — "nesting is for reading, not for
 * access" is the comment on `Project.parent_id`, and "empty means every project,
 * not none" is the comment on `Cycle.projects` and again on `Module.projects`.
 * Each is a decision somebody would otherwise discover by testing.
 */
import { beats } from '../../spots/hierarchy/copy';
import { HierarchyTree } from '../../components/HierarchyTree';
import { Identifier } from '../../components/Identifier';
import { Nesting } from '../../components/Nesting';
import { Spanning } from '../../components/Spanning';
import { SubTasks } from '../../components/SubTasks';
import type { Carousel } from '../slide';

const W = 912;

export const hierarchy: Carousel = {
  id: 'SocialHierarchy',
  about: 'the six levels, identifiers, and the two rules — nesting is not access, empty means all',
  slides: [
    {
      kind: 'cover',
      kicker: 'Hierarchy',
      headline: 'Six levels, and two rules.',
      sub: 'Workspace, team, project, cycle, task, sub-task — and every one of them a table you can read.',
    },
    {
      kind: 'point',
      ...beats.tree,
      visual: {
        /* Frame 200: past the last node's arrival, so the whole tree is standing. */
        height: 545,
        node: <HierarchyTree frame={200} width={W} size={24} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      ...beats.identifier,
      visual: {
        height: 300,
        node: <Identifier frame={130} width={W} size={26} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'Sub-tasks',
      headline: 'A sub-task is a whole task.',
      sub: 'Its own identifier, its own assignee, its own due date — and its own card on the board. Not a checklist item, which is why the shape stops here rather than growing a new kind of thing.',
      visual: {
        height: 340,
        node: <SubTasks frame={160} width={W} size={26} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      ...beats.nesting,
      visual: {
        /* Frame 140: the private project is hidden and the guest is looking. */
        height: 360,
        node: <Nesting frame={140} width={W} size={23} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      ...beats.spanning,
      visual: {
        /* Frame 130: the bar has widened from two projects to all three. */
        height: 280,
        node: <Spanning frame={130} width={W} size={23} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'The two rules',
      headline: 'Nesting is for reading. Empty means all.',
      sub: 'A project under another project is a way of listing them, not a way of granting anything. A cycle that names no projects runs in every one of them — and that is written on the column, not left to be discovered.',
    },
    {
      kind: 'close',
      kicker: 'Hierarchy',
      headline: 'Six levels, and every one of them a table you can read.',
      sub: 'It is a SQLite file. You can open it.',
    },
  ],
};
