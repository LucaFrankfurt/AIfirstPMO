/**
 * The quiet link into the part of the guide that explains the screen you are on.
 *
 * It used to live in `ui.tsx`, which meant the design system knew where the
 * guide keeps its anchors. `Empty` asks for a hint now and this says what one
 * looks like — so a build without the guide shows no hint rather than failing
 * to compile, and the design system is back to knowing only about itself.
 */
import { Link } from 'react-router-dom';
import { Icon, provideGuideHint } from '../../kernel/design-system/ui';
import { useT } from '../../kernel/i18n/i18n';
import { guideHref, type GuideTarget } from './guide';

export function GuideHint({ to, className = '' }: { to: GuideTarget; className?: string }) {
  const t = useT();
  return (
    <Link className={`guide-hint ${className}`} to={guideHref(to)}>
      <Icon name="help" size={13} />
      {t('guide.explainThis')}
    </Link>
  );
}

/** Hung off `Empty` by `wiring.ts`. */
export const installGuideHint = (): void => provideGuideHint((to) => <GuideHint to={to} />);
