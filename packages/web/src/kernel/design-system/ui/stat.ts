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
export const statRow = 'grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 mb-4';
export const statTile = 'flex flex-col gap-0.5 rounded border border-line bg-bg px-3.5 py-3 '
  + '[button&]:w-full [button&]:cursor-pointer [button&]:text-start '
  + '[button&]:hover:border-line-strong [button&]:hover:bg-hover '
  + 'aria-pressed:border-accent aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-accent';
export const statLabel = 'text-label text-soft';
export const statValue = 'text-display font-[620] leading-[1.1] tracking-[-0.4px]';
export const statHint = 'text-caption text-muted';
