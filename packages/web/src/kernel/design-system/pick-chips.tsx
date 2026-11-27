/**
 * Any number of things from a list that grows: chips for what is chosen, a menu
 * for the rest.
 *
 * It was a meeting's own — the people expected, the projects a point is about —
 * and moved here when an incident wanted the same shape twice, for the
 * applications it hit and the people working it. One copy, because two would
 * drift on the one thing that matters: what removing a chip announces to a
 * screen reader.
 */
import { Icon, MenuButton } from './ui';
import { Chip } from './ui/chip';

/**
 * Chips for what is chosen, a menu for the rest.
 *
 * One shape for every "any number of these, from a list that grows with the
 * workspace" — attendees, projects, affected applications, responders — and
 * the menu's own search is what makes forty names usable.
 */
export function PickChips({
  chosen, options, onChange, addLabel, removeLabel, disabled,
}: {
  chosen: string[];
  options: { id: string; label: string }[];
  onChange: (next: string[]) => void;
  addLabel: string;
  removeLabel: (label: string) => string;
  disabled?: boolean;
}) {
  const named = new Map(options.map((option) => [option.id, option.label]));
  const rest = options.filter((option) => !chosen.includes(option.id));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chosen.filter((id) => named.has(id)).map((id) => (
        <Chip key={id} className="gap-1 pr-0.5">
          {named.get(id)}
          {!disabled && (
            <button
              type="button"
              className="pick-remove"
              aria-label={removeLabel(named.get(id) ?? '')}
              onClick={() => onChange(chosen.filter((one) => one !== id))}
            >
              <Icon name="close" size={11} />
            </button>
          )}
        </Chip>
      ))}
      {!disabled && rest.length > 0 && (
        <MenuButton
          size="sm"
          label={addLabel}
          search={rest.length > 8}
          items={rest.map((option) => ({ id: option.id, label: option.label, onSelect: () => onChange([...chosen, option.id]) }))}
        >
          <Icon name="plus" size={13} /> <span>{addLabel}</span>
        </MenuButton>
      )}
    </div>
  );
}
