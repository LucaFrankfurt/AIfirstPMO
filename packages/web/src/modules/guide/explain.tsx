/**
 * The guide's animation engine.
 *
 * Every diagram is a pure function of one number: the step it is on. Motion
 * comes from CSS transitions between those steps, which buys three things a
 * hand-rolled keyframe animation does not:
 *
 *   - each step carries a sentence, so the picture is narrated rather than
 *     merely decorative, and a screen reader gets the same explanation;
 *   - the viewer can pause, step back, or jump to a step, so nobody has to
 *     wait for a loop to come round again;
 *   - `prefers-reduced-motion` simply means "do not advance on its own" —
 *     the diagram still works, it just waits to be driven.
 *
 * Stages also idle until they are actually on screen. Nine looping animations
 * running behind the fold is exactly the kind of thing that makes a laptop fan
 * spin for no reason.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT, type TranslationKey } from '../../kernel/i18n/i18n';
import { Button } from '../../kernel/design-system/ui/button';
import { Icon } from '../../kernel/design-system/ui';

/* --------------------------------------------------------------- motion */

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** True once the element has been scrolled into view far enough to be worth animating. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver !== 'function') {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.3 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return onScreen;
}

/* ---------------------------------------------------------------- stage */

export interface StageProps {
  /** One sentence per step, in order. The count of these is the step count. */
  captions: TranslationKey[];
  /** The picture. Everything inside should be a function of `step`. */
  children: (step: number) => ReactNode;
  /**
   * Floor for the scene box in pixels. It is a minimum rather than a fixed
   * height because the same scene stacks into a column on a narrow screen and
   * then needs more room than it does side by side.
   */
  minHeight?: number;
  /** Milliseconds per step. Slower for diagrams with more to read. */
  interval?: number;
  /** Screen-reader label for the whole figure. */
  label: TranslationKey;
}

export function Stage({ captions, children, minHeight = 232, interval = 3000, label }: StageProps) {
  const t = useT();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(ref);

  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(!reduced);

  // The OS setting can change while the page is open.
  useEffect(() => setPlaying(!reduced), [reduced]);

  useEffect(() => {
    if (!playing || !onScreen) return;
    const handle = setInterval(() => setStep((current) => (current + 1) % captions.length), interval);
    return () => clearInterval(handle);
  }, [playing, onScreen, interval, captions.length]);

  const go = useCallback(
    (delta: number) => {
      setPlaying(false);
      setStep((current) => (current + delta + captions.length) % captions.length);
    },
    [captions.length],
  );

  return (
    <figure className="stage" ref={ref} aria-label={t(label)}>
      <div className="scene" style={{ minHeight }} data-step={step}>
        {children(step)}
      </div>

      <figcaption className="stage-foot">
        {/* The narration is the accessible version of the picture, so it is a
            live region rather than something only sighted viewers benefit from. */}
        <p className="caption" aria-live="polite">
          <span className="ordinal">{step + 1}/{captions.length}</span>
          {t(captions[step])}
        </p>

        <div className="controls">
          <div className="dots" role="tablist" aria-label={t('guide.steps')}>
            {captions.map((caption, index) => (
              <button
                key={caption}
                role="tab"
                aria-selected={index === step}
                aria-label={t(caption)}
                className={index === step ? 'on' : ''}
                onClick={() => {
                  setPlaying(false);
                  setStep(index);
                }}
              />
            ))}
          </div>
          <span className="flex-1 min-w-0" />
          <Button variant="ghost" size="iconSm" onClick={() => go(-1)} aria-label={t('guide.previousStep')}>
            <Icon name="chevronLeft" size={14} />
          </Button>
          <Button variant="ghost" size="iconSm"
            onClick={() => setPlaying((current) => !current)}
            aria-label={t(playing ? 'guide.pause' : 'guide.play')}
            title={t(playing ? 'guide.pause' : 'guide.play')}
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} />
          </Button>
          <Button variant="ghost" size="iconSm" onClick={() => go(1)} aria-label={t('guide.nextStep')}>
            <Icon name="chevronRight" size={14} />
          </Button>
        </div>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------- miniature interface */

/**
 * The diagrams show a simplified Kolibri rather than abstract boxes: a viewer
 * who has just watched a card move between two columns can find that same card
 * in the real interface a moment later. These are the pieces they are built from.
 */

export const Frame = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`gx-frame ${className}`}>{children}</div>
);

export const Row = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`gx-row ${className}`}>{children}</div>
);

/** A task line: identifier, title, and optional trailing chips. */
export function MiniTask({
  id, title, done, dim, accent, children,
}: { id: string; title: string; done?: boolean; dim?: boolean; accent?: boolean; children?: ReactNode }) {
  return (
    <div className={`gx-task${done ? ' done' : ''}${dim ? ' dim' : ''}${accent ? ' accent' : ''}`}>
      <span className="gx-dot" data-done={done ? 'true' : undefined} />
      <span className="gx-id">{id}</span>
      <span className="gx-title">{title}</span>
      {children}
    </div>
  );
}

export const MiniChip = ({ children, tone }: { children: ReactNode; tone?: 'accent' | 'warn' | 'ok' | 'danger' }) => (
  <span className={`gx-chip${tone ? ` ${tone}` : ''}`}>{children}</span>
);

/** A labelled container — a workspace, a project, a device. */
export function MiniBox({
  title, tone, on = true, children, className = '',
}: {
  title?: ReactNode;
  tone?: 'muted';
  /** Boxes fade and lift in as the steps reveal them. */
  on?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`gx-box${tone ? ` ${tone}` : ''} ${className}`} data-on={on ? 'true' : 'false'}>
      {title && <div className="gx-box-title">{title}</div>}
      {children}
    </div>
  );
}

/** A keyboard cap, pressed or not. */
export const Key = ({ children, pressed }: { children: ReactNode; pressed?: boolean }) => (
  <kbd className={`gx-key${pressed ? ' pressed' : ''}`}>{children}</kbd>
);

/**
 * A connector between two panels of a scene.
 *
 * Deliberately a flow-layout element rather than an SVG overlay: an overlay
 * has to guess where the boxes ended up, and a stretched `viewBox` shears the
 * arrowheads at any width it was not drawn for. Three travelling dots survive
 * every width, stack sensibly on a phone, and say "data is moving, this way"
 * without a caption having to spell it out.
 */
export const Conn = ({
  on, dir = 'right', tone = 'accent',
}: { on?: boolean; dir?: 'right' | 'left' | 'down' | 'up'; tone?: 'accent' | 'ok' }) => (
  <span className={`gx-conn ${dir} ${tone}`} data-on={on ? 'true' : 'false'} aria-hidden="true">
    <i /><i /><i />
  </span>
);
