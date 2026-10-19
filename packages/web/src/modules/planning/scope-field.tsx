/**
 * Choosing what a cycle or a milestone covers, and saying what that costs.
 *
 * Both are scoped by the same pair — `project_id` set is one project's own,
 * `project_id` null with an empty `projects` is every project, a list is
 * exactly those — so both forms ask the same question in the same three ways,
 * and both have the same thing to warn about: narrowing one leaves the dropped
 * projects' work inside something their project is no longer part of.
 *
 * One copy, because the cycle's version shipped first and the milestone's was
 * about to be the second. The rule they share is mechanical — read the stored
 * pair back as a choice, write the choice back as a pair, and count what falls
 * outside it; the wording is not, so the strings are handed in. A `t('…')` built
 * from a prefix would be a key no catalogue check can see.
 *
 * Nothing here moves work. A task keeps its `cycle_id` or `module_id`: dropping
 * a project is a decision about the cycle, and taking somebody's task out of a
 * sprint is a different decision that is not a scope control's to make.
 */
import { useState } from 'react';
import { projectScope, type ProjectScope, type Task } from '@kolibri/shared';
import { chipVariants } from '../../kernel/design-system/ui/chip';
import { Select } from '../../kernel/design-system/ui/field';

/** The three answers a form offers, which are not the two columns it stores. */
export type ScopeChoice = 'this' | 'some' | 'all';

/** What a project has to say for itself to be offered as a destination. */
export interface ScopeProject {
  id: string;
  name: string;
  icon?: string | null;
}

/** The wording, which differs between the two even where the rule does not. */
export interface ScopeLabels {
  legend: string;
  this: string;
  some: string;
  all: string;
  thisHint: string;
  someHint: string;
  allHint: string;
  pickOne: string;
  /** Takes `{count}`. */
  strandTitle: string;
  /** Takes `{count}`. */
  strandMore: string;
  strandHint: string;
}

/**
 * The stored pair, read back as the choice that produced it.
 *
 * A list is "chosen projects"; an owner is "just this project" when it *is*
 * this project. Almost always it is — a cycle this screen can show either names
 * this project or names none — but a row reached by a link after the project
 * was re-filed could name another one, and calling that "this project" would
 * quietly move it on the next save. It comes out as the list of one it is,
 * which `projectScope` stores back as the owner it was.
 */
export function useScopeChoice(row: ProjectScope | undefined, projectId: string) {
  const listed = row?.projects ?? [];
  const owner = row?.project_id ?? null;
  const [scope, setScope] = useState<ScopeChoice>(() => {
    if (!row) return 'this';
    if (listed.length) return 'some';
    return owner ? (owner === projectId ? 'this' : 'some') : 'all';
  });
  const [picked, setPicked] = useState<string[]>(
    () => (listed.length ? [...listed] : [owner ?? projectId]),
  );

  const settled = projectScope(
    scope === 'this' ? { project: projectId } : scope === 'all' ? {} : { projects: picked },
  );
  // "Chosen projects" with nothing chosen is the one answer that is not an
  // answer. One project picked is the same thing as "just this project", and
  // `projectScope` stores it that way, so that case needs no refusing.
  const incomplete = scope === 'some' && !picked.length;

  return { scope, setScope, picked, setPicked, settled, incomplete };
}

export function ProjectScopeField({
  id, scope, onScope, picked, onPicked, projects, stranded, labels,
}: {
  id: string;
  scope: ScopeChoice;
  onScope: (next: ScopeChoice) => void;
  picked: string[];
  onPicked: (next: string[]) => void;
  projects: ScopeProject[];
  /** The work this choice would leave behind. Empty while nothing would be. */
  stranded: Task[];
  labels: ScopeLabels;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{labels.legend}</label>
      <Select id={id} value={scope} onChange={(event) => onScope(event.target.value as ScopeChoice)}>
        <option value="this">{labels.this}</option>
        <option value="some">{labels.some}</option>
        <option value="all">{labels.all}</option>
      </Select>
      <span className="text-[12px] text-muted mt-1">
        {scope === 'this' ? labels.thisHint : scope === 'all' ? labels.allHint : labels.someHint}
      </span>

      {scope === 'some' && (
        <div className="mt-2 grid gap-1">
          {projects.map((project) => (
            <label className="check-row" key={project.id}>
              <input
                type="checkbox"
                checked={picked.includes(project.id)}
                onChange={(event) => onPicked(
                  event.target.checked
                    ? [...picked, project.id]
                    : picked.filter((one) => one !== project.id),
                )}
              />
              <span>{project.icon} {project.name}</span>
            </label>
          ))}
          {!picked.length && <span className="text-[12px] text-danger">{labels.pickOne}</span>}
        </div>
      )}

      {/* What it would cost, while the choice is still being made rather than
          reported after the save. Named rather than counted: "3 tasks" is a
          number somebody then has to go and find. Said plainly that nothing is
          removed, because "stranded" otherwise reads as "deleted" to the person
          about to press Save. */}
      {stranded.length > 0 && (
        <div className="mt-2.5 rounded-[var(--radius-sm)] border border-line bg-sunken p-2.5">
          <strong className="block text-[12.5px] text-danger">{labels.strandTitle}</strong>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            {stranded.slice(0, 12).map((task) => (
              <span className={chipVariants()} key={task.id} title={task.title}>
                <span className="mono">{task.identifier}</span>
              </span>
            ))}
            {stranded.length > 12 && <span className="text-[12px] text-muted">{labels.strandMore}</span>}
          </span>
          <span className="mt-1.5 block text-[12px] text-muted">{labels.strandHint}</span>
        </div>
      )}
    </div>
  );
}
