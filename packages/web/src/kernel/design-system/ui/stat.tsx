/**
 * A figure with its name above it and a line of context under it: the tiles at
 * the top of an index, the summary over a list.
 *
 * Class strings for the reason the form layouts in `field.tsx` are: twenty rows
 * and a dozen tiles already wrote these as classes on plain elements, and what
 * was worth changing is where the styling lives. The tile that is a button —
 * a figure that is also a door — is marked when pressed by its outline rather
 * than a fill, so the numbers keep the surface their contrast was measured on.
 * The outline is a `ring`, which is an inset shadow underneath; written as an
 * arbitrary `shadow-[…]` it would have been a shadow off the scale.
 */
// `kpi-row`, `stat`, `stat-label`, `stat-value` draw nothing any more: the
// walkthrough reads My work's figures by them.
export const statRow = 'kpi-row grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 mb-4';
export const statTile = 'stat flex flex-col gap-0.5 rounded border border-line bg-bg px-3.5 py-3 '
  + '[button&]:w-full [button&]:cursor-pointer [button&]:text-start '
  + '[button&]:hover:border-line-strong [button&]:hover:bg-hover '
  + 'aria-pressed:border-accent aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-accent';
export const statLabel = 'stat-label text-label text-soft';
export const statValue = 'stat-value text-display font-[620] leading-[1.1] tracking-[-0.4px]';
export const statHint = 'stat-hint text-caption text-muted';

/*
 * The tile as a component, moved down from `modules/planning/insights.tsx`:
 * six capabilities drew their figures with it, and every one of them reached
 * into planning to do so — the cross-capability reach `docs/modules.md`
 * describes, for a piece of furniture.
 */
/**
 * A headline number. Not a one-bar bar chart.
 *
 * With `onSelect` it is also the way into what it counted, and becomes a real
 * button rather than a div that listens for clicks — so it is tabbable, says
 * `aria-pressed`, and answers the space bar. Without one it stays a figure: a
 * tile that reads as pressable and shows a different set than the number on it
 * is worse than a tile that does nothing.
 */
export function Stat({ label, value, hint, onSelect, active }: {
  label: string;
  value: string;
  hint?: string;
  onSelect?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <span className={statLabel}>{label}</span>
      <strong className={statValue}>{value}</strong>
      {hint && <span className={statHint}>{hint}</span>}
    </>
  );
  if (!onSelect) return <div className={statTile}>{body}</div>;
  return (
    <button type="button" className={statTile} aria-pressed={!!active} onClick={onSelect}>
      {body}
    </button>
  );
}
