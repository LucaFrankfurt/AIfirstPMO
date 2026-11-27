/**
 * The surface of everything that floats over content: menus, their drawers,
 * popovers.
 *
 * Glass, because a menu is the one surface whose job is to be temporary, and
 * letting the page show through says so — it is over the screen, not part of
 * it. The token does the careful part: `--glass` is opaque enough that the
 * faintest ink still clears 4.6:1 with solid `--fg` behind it, and it turns
 * fully opaque for anybody who asked the OS for less transparency or more
 * contrast, and in a browser that cannot blur. So this string can say
 * "translucent" and never be unreadable.
 *
 * One string rather than three copies of it: the menu, its drawer and the
 * popover were the same box written three times, and the drawer's copy was the
 * one that had kept an older radius.
 */
export const floatingSurface = 'rounded border border-line/70 bg-glass text-fg shadow backdrop-blur-xl backdrop-saturate-150';
