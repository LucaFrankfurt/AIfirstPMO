/**
 * The hierarchy explorer.
 *
 * Most questions people have about a tool like this are really questions about
 * containment: *where does a cycle live, can a task be in two of them, what
 * happens to sub-tasks when I delete a project.* So the tree is the interface —
 * pick a node and it tells you what it holds, what holds it, and the one rule
 * that trips people up.
 *
 * The tree is a literal transcription of `ENTITIES` in `@kolibri/shared`; if a
 * relationship changes there, it should change here.
 */
import { useState } from 'react';
import { useT, type TranslationKey } from '../lib/i18n';
import { Icon } from './ui';

interface Node {
  id: string;
  /** Icon name, or a single emoji. */
  glyph: string;
  name: TranslationKey;
  what: TranslationKey;
  /** The constraint worth knowing before you design around it. */
  rule: TranslationKey;
  children?: Node[];
  /**
   * What holds this when the containment tree does not. The three rows below
   * the tree hang off a person, not off the workspace, and saying "this is the
   * top" about an API token would be plainly wrong.
   */
  belongsTo?: TranslationKey;
}

const TREE: Node[] = [
  {
    id: 'workspace',
    glyph: 'home',
    name: 'guide.node.workspace',
    what: 'guide.node.workspaceWhat',
    rule: 'guide.node.workspaceRule',
    children: [
      {
        id: 'member',
        glyph: 'users',
        name: 'guide.node.member',
        what: 'guide.node.memberWhat',
        rule: 'guide.node.memberRule',
      },
      {
        id: 'team',
        glyph: 'users',
        name: 'guide.node.team',
        what: 'guide.node.teamWhat',
        rule: 'guide.node.teamRule',
      },
      {
        id: 'project',
        glyph: 'folder',
        name: 'guide.node.project',
        what: 'guide.node.projectWhat',
        rule: 'guide.node.projectRule',
        children: [
          {
            id: 'state',
            glyph: 'check',
            name: 'guide.node.state',
            what: 'guide.node.stateWhat',
            rule: 'guide.node.stateRule',
          },
          {
            id: 'label',
            glyph: 'bolt',
            name: 'guide.node.label',
            what: 'guide.node.labelWhat',
            rule: 'guide.node.labelRule',
          },
          {
            id: 'cycle',
            glyph: 'cycle',
            name: 'guide.node.cycle',
            what: 'guide.node.cycleWhat',
            rule: 'guide.node.cycleRule',
          },
          {
            id: 'module',
            glyph: 'target',
            name: 'guide.node.module',
            what: 'guide.node.moduleWhat',
            rule: 'guide.node.moduleRule',
          },
          {
            id: 'task',
            glyph: 'check',
            name: 'guide.node.task',
            what: 'guide.node.taskWhat',
            rule: 'guide.node.taskRule',
            children: [
              {
                id: 'subtask',
                glyph: 'check',
                name: 'guide.node.subtask',
                what: 'guide.node.subtaskWhat',
                rule: 'guide.node.subtaskRule',
              },
              {
                id: 'relation',
                glyph: 'link',
                name: 'guide.node.relation',
                what: 'guide.node.relationWhat',
                rule: 'guide.node.relationRule',
              },
              {
                id: 'comment',
                glyph: 'inbox',
                name: 'guide.node.comment',
                what: 'guide.node.commentWhat',
                rule: 'guide.node.commentRule',
              },
              {
                id: 'file',
                glyph: 'attach',
                name: 'guide.node.file',
                what: 'guide.node.fileWhat',
                rule: 'guide.node.fileRule',
              },
            ],
          },
          {
            id: 'template',
            glyph: 'copy',
            name: 'guide.node.template',
            what: 'guide.node.templateWhat',
            rule: 'guide.node.templateRule',
          },
          {
            id: 'automation',
            glyph: 'refresh',
            name: 'guide.node.automation',
            what: 'guide.node.automationWhat',
            rule: 'guide.node.automationRule',
          },
          {
            id: 'projectPage',
            glyph: 'page',
            name: 'guide.node.projectPage',
            what: 'guide.node.projectPageWhat',
            rule: 'guide.node.projectPageRule',
          },
        ],
      },
      {
        id: 'page',
        glyph: 'page',
        name: 'guide.node.page',
        what: 'guide.node.pageWhat',
        rule: 'guide.node.pageRule',
      },
    ],
  },
];

/** Things that hang off a person rather than off the tree. */
const ASIDE: Node[] = [
  {
    id: 'notification',
    glyph: 'bell',
    name: 'guide.node.notification',
    what: 'guide.node.notificationWhat',
    rule: 'guide.node.notificationRule',
    belongsTo: 'guide.hierarchy.aPerson',
  },
  {
    id: 'timeEntry',
    glyph: 'cycle',
    name: 'guide.node.time',
    what: 'guide.node.timeWhat',
    rule: 'guide.node.timeRule',
    belongsTo: 'guide.hierarchy.aTask',
  },
  {
    id: 'view',
    glyph: 'filter',
    name: 'guide.node.view',
    what: 'guide.node.viewWhat',
    rule: 'guide.node.viewRule',
    belongsTo: 'guide.hierarchy.aPerson',
  },
  {
    id: 'token',
    glyph: 'sparkle',
    name: 'guide.node.token',
    what: 'guide.node.tokenWhat',
    rule: 'guide.node.tokenRule',
    belongsTo: 'guide.hierarchy.aPerson',
  },
];

/** Index every node once so the detail panel can look up parents and children. */
function flatten(nodes: Node[], parent: Node | null, into: Map<string, { node: Node; parent: Node | null }>) {
  for (const node of nodes) {
    into.set(node.id, { node, parent });
    if (node.children) flatten(node.children, node, into);
  }
  return into;
}

const INDEX = flatten([...TREE, ...ASIDE], null, new Map());

function Branch({
  node, depth, selected, onSelect,
}: { node: Node; depth: number; selected: string; onSelect: (id: string) => void }) {
  const t = useT();
  return (
    <>
      <button
        className={`gx-node${selected === node.id ? ' on' : ''}`}
        style={{ paddingInlineStart: 8 + depth * 16 }}
        onClick={() => onSelect(node.id)}
        aria-current={selected === node.id}
      >
        <span className="gx-node-glyph">
          {node.glyph.length <= 2 ? node.glyph : <Icon name={node.glyph} size={13} />}
        </span>
        <span className="gx-node-name">{t(node.name)}</span>
        {node.children && <span className="gx-node-count">{node.children.length}</span>}
      </button>
      {node.children?.map((child) => (
        <Branch key={child.id} node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
      ))}
    </>
  );
}

export function HierarchyExplorer() {
  const t = useT();
  const [selected, setSelected] = useState('task');
  const entry = INDEX.get(selected) ?? INDEX.get('task')!;
  const { node, parent } = entry;

  return (
    <div className="gx-hierarchy">
      <div className="gx-tree-pane">
        {TREE.map((root) => (
          <Branch key={root.id} node={root} depth={0} selected={selected} onSelect={setSelected} />
        ))}
        <div className="gx-node-group">{t('guide.hierarchy.outside')}</div>
        {ASIDE.map((root) => (
          <Branch key={root.id} node={root} depth={0} selected={selected} onSelect={setSelected} />
        ))}
      </div>

      <div className="gx-detail" aria-live="polite">
        <div className="gx-detail-head">
          <span className="gx-node-glyph big">
            {node.glyph.length <= 2 ? node.glyph : <Icon name={node.glyph} size={17} />}
          </span>
          <strong>{t(node.name)}</strong>
        </div>
        <p>{t(node.what)}</p>

        <dl className="gx-detail-facts">
          <dt>{t('guide.hierarchy.livesIn')}</dt>
          <dd>
            {parent ? (
              <button className="gx-link" onClick={() => setSelected(parent.id)}>{t(parent.name)}</button>
            ) : (
              t(node.belongsTo ?? 'guide.hierarchy.topLevel')
            )}
          </dd>

          <dt>{t('guide.hierarchy.contains')}</dt>
          <dd>
            {node.children?.length ? (
              <span className="gx-chip-row">
                {node.children.map((child) => (
                  <button className="gx-link chip" key={child.id} onClick={() => setSelected(child.id)}>
                    {t(child.name)}
                  </button>
                ))}
              </span>
            ) : (
              t('guide.hierarchy.nothing')
            )}
          </dd>
        </dl>

        <div className="gx-rule">
          <Icon name="bolt" size={13} />
          <span>{t(node.rule)}</span>
        </div>
      </div>
    </div>
  );
}
