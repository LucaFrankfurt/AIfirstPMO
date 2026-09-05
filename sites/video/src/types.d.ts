/**
 * Remotion's bundler emits an image import as a URL; TypeScript needs telling.
 * `.webp` is here because every product screenshot in this repository is one —
 * they are screenshots of flat UI, which is the case webp is actually good at.
 */
declare module '*.webp' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
