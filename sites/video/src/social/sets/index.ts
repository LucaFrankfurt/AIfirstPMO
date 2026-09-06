/**
 * Every carousel, in the order somebody new to the account should meet them.
 *
 * A set is data; the compositions are built from it in `Root.tsx`. Adding one is
 * a file here and a line below, and `npm run social` renders all of them without
 * anybody having to remember which.
 *
 * The order is the order of a conversation, not of the product: what it is,
 * then the one feature that sells it, then the promise that is hardest to
 * believe, then the shape you have to hold in your head, then the two audiences
 * who came for one specific thing.
 */
import { pitch } from './pitch';
import { quickadd } from './quickadd';
import { offline } from './offline';
import { hierarchy } from './hierarchy';
import { assistant } from './assistant';
import { selfhost } from './selfhost';
import { singles } from './singles';

export const carousels = [
  pitch,
  quickadd,
  offline,
  hierarchy,
  assistant,
  selfhost,
  /* Not a carousel. Last, because it is a folder rather than an argument. */
  singles,
] as const;
