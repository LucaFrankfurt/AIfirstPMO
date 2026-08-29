/**
 * The parts a KPI screen is drawn from.
 *
 * The chart here is not `BurnChart` with different numbers, and the difference
 * is the whole reason it exists: a budget's months are a fixed ladder of equal
 * rungs, and readings are not. Somebody measures uptime weekly for a month,
 * forgets it for two, then takes three in a week — and a chart that spaced
 * those evenly would draw a steady climb over a gap where nothing was known.
 * So the x axis here is time, not an index.
 */
import { useState } from 'react';
import {
  formatMeasure, parseMeasure, type Kpi, type KpiProgress, type MeasureHealth, type SeriesPoint,
} from '@kolibri/shared';
import { Table } from './insights';
import { Icon } from './ui';
import { Chip } from './ui/chip';
import { Input } from './ui/field';
import { currentLocale, useT, type TranslationKey } from '../lib/i18n';
import { shortDate } from '../lib/format';

export const healthKey = (health: string): TranslationKey => `kpi.health.${health}` as TranslationKey;
export const unitKey = (unit: string): TranslationKey => `kpi.unit.${unit}` as TranslationKey;
export const cadenceKey = (cadence: string): TranslationKey => `kpi.cadence.${cadence}` as TranslationKey;
export const directionKey = (direction: string): TranslationKey => `kpi.direction.${direction}` as TranslationKey;

/**
 * Written out rather than built from the value, because `check:css` reads the
 * source for class names and a template literal is a name it cannot check.
 * `no_data` and `no_target` share the muted treatment: both mean "nobody has
 * said", which is a different thing from a judgement and should not look like
 * one.
 */
const HEALTH_CLASS: Record<MeasureHealth, string> = {
  no_data: 'kpi-quiet',
  no_target: 'kpi-quiet',
  stale: 'kpi-stale',
  on_track: 'kpi-on',
  at_risk: 'kpi-risk',
  off_track: 'kpi-off',
};

export const measure = (value: number | null | undefined, kpi: Pick<Kpi, 'unit' | 'unit_label' | 'decimals'>): string =>
  formatMeasure(value, kpi, currentLocale());

export function Health({ health }: { health: MeasureHealth }) {
  const t = useT();
  return <Chip className={HEALTH_CLASS[health]}>{t(healthKey(health))}</Chip>;
}

/**
 * Which way it moved, and whether that was the good way.
 *
 * The arrow says the direction of travel and the colour says whether that is
 * an improvement, because for half the KPIs in a workspace those are opposite:
 * churn falling is an arrow down and a good thing. Fusing them into one symbol
 * would mean either an arrow that lies about the number or a colour that lies
 * about the intent.
 */
export function Trend({ change, better, kpi }: {
  change: number | null;
  better: boolean | null;
  kpi: Pick<Kpi, 'unit' | 'unit_label' | 'decimals'>;
}) {
  const t = useT();
  if (change === null) return <span className="text-muted">—</span>;
  if (change === 0) return <span className="text-muted">{t('kpi.unchanged')}</span>;
  const tone = better === null ? '' : better ? ' kpi-better' : ' kpi-worse';
  return (
    <span className={`kpi-trend${tone}`}>
      <Icon name={change > 0 ? 'chevronUp' : 'chevronDown'} size={13} />
      {measure(Math.abs(change), kpi)}
    </span>
  );
}

/**
 * How far it has come against how far it should have.
 *
 * Two bars in one track rather than a number, because the judgement *is* the
 * comparison: 60% of the way there is excellent in March and late in November,
 * and a single percentage cannot say which. The pale mark is where the straight
 * line from baseline to target says today should be.
 */
export function Pace({ progress }: { progress: KpiProgress }) {
  const t = useT();
  if (progress.achieved === null) return null;
  const done = Math.max(0, Math.min(100, progress.achieved / 100));
  const due = progress.expected === null ? null : Math.max(0, Math.min(100, progress.expected / 100));
  return (
    <div
      className="pace"
      role="img"
      aria-label={t('kpi.paceLabel', {
        achieved: String(Math.round(progress.achieved / 100)),
        expected: String(Math.round((progress.expected ?? 10_000) / 100)),
      })}
    >
      <div className="pace-track">
        {done > 0 && <div className="pace-fill" style={{ width: `${done}%` }} />}
        {due !== null && <div className="pace-mark" style={{ insetInlineStart: `${due}%` }} />}
      </div>
    </div>
  );
}

/**
 * Readings over time, with the target as the line they are judged against.
 *
 * Two decisions worth naming.
 *
 * **The x axis is time.** Readings arrive when somebody takes them, and spacing
 * them evenly would draw a straight climb across a three-month gap where
 * nothing was measured. A gap should look like a gap.
 *
 * **The y axis does not start at zero, and says so.** A percentage moving
 * between 90 and 100 charted from zero is a flat line at the top: the reader
 * learns nothing about the only ten points that matter. So the scale is fitted
 * to what is actually on the chart — readings, baseline and targets — and both
 * ends of it are printed beside the plot, because a truncated axis that does
 * not announce itself is the oldest way to make a small change look enormous.
 *
 * **The measured line is neutral, not green.** Half the KPIs in a workspace are
 * better when the line falls, so a green line climbing is a picture that
 * contradicts itself: on a lead time going the wrong way it says "good" in
 * colour while saying "worse" in shape. Colouring per direction would mean the
 * same series changing colour on the settings screen, and colouring per segment
 * gives a rainbow nobody can read. The judgement is carried by the chip, the
 * pace bar and the sentence above the chart; the line just says what happened.
 */
export function MeasureChart({ actual, target, kpi, caption }: {
  actual: SeriesPoint[];
  target: SeriesPoint[];
  kpi: Kpi;
  caption: string;
}) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const points = [...actual, ...target];
  if (!actual.length) return null;

  const days = points.map((point) => Date.parse(`${point.on}T00:00:00Z`));
  const first = Math.min(...days);
  const last = Math.max(...days);
  const span = last - first || 1;

  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A hair of headroom, so a reading that touches the extreme is not drawn on
  // the frame. A flat series gets a band rather than a division by zero.
  const pad = (high - low) * 0.08 || Math.max(1, Math.abs(high) * 0.05);
  const bottom = low - pad;
  const top = high + pad;

  const x = (on: string) => ((Date.parse(`${on}T00:00:00Z`) - first) / span) * 100;
  const y = (value: number) => 100 - ((value - bottom) / (top - bottom)) * 100;
  const path = (series: SeriesPoint[]) => series.map((point) => `${x(point.on)},${y(point.value)}`).join(' ');

  return (
    <figure className="chart">
      <div className="chart-legend">
        <span><i style={{ background: 'var(--chart-1)' }} aria-hidden /> {t('kpi.measured')}</span>
        {target.length > 0 && <span><i style={{ background: 'var(--fg-soft)' }} aria-hidden /> {t('kpi.target')}</span>}
      </div>
      {/* Both ends of the scale, because it does not start at zero. */}
      <div className="chart-scale"><span>{measure(Math.round(top), kpi)}</span><span>{measure(Math.round(bottom), kpi)}</span></div>
      <div
        className="chart-plot lines"
        style={{ height: 190 }}
        role="img"
        aria-label={caption}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          // Nearest reading in *time*, not the nearest index: with an uneven
          // series those are different points, and the crosshair should land on
          // the one under the pointer.
          const wanted = first + ratio * span;
          let best = 0;
          for (let index = 1; index < actual.length; index++) {
            const here = Date.parse(`${actual[index].on}T00:00:00Z`);
            if (Math.abs(here - wanted) < Math.abs(Date.parse(`${actual[best].on}T00:00:00Z`) - wanted)) best = index;
          }
          setHover(best);
        }}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="lines-svg">
          {[0, 50, 100].map((line) => (
            <line key={line} x1="0" x2="100" y1={line} y2={line} className="grid-line" vectorEffect="non-scaling-stroke" />
          ))}
          {hover !== null && actual[hover] && (
            <line
              x1={x(actual[hover].on)} x2={x(actual[hover].on)} y1="0" y2="100"
              className="crosshair" vectorEffect="non-scaling-stroke"
            />
          )}
          {target.length > 1 && (
            <polyline
              points={path(target)} fill="none" stroke="var(--fg-soft)" strokeWidth="2"
              strokeDasharray="4 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            points={path(actual)} fill="none" stroke="var(--chart-1)" strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
          />
          {/* A single reading has no line to draw, and a dot is the honest
              picture of one measurement. */}
          {actual.length === 1 && (
            <circle cx={x(actual[0].on)} cy={y(actual[0].value)} r="2.5" fill="var(--chart-1)" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {hover !== null && actual[hover] && (
          <span className="chart-tip pinned" role="status" style={{ left: `${x(actual[hover].on)}%` }}>
            {shortDate(actual[hover].on)} · {measure(actual[hover].value, kpi)}
          </span>
        )}
      </div>
      <div className="chart-axis">
        <span className="flex-1">{shortDate(actual[0].on)}</span>
        <span style={{ flex: 1, textAlign: 'end' }}>
          {shortDate((target.length ? target[target.length - 1] : actual[actual.length - 1]).on)}
        </span>
      </div>
      <figcaption>{caption}</figcaption>
      <Table
        caption={t('insights.tableView')}
        head={[t('kpi.measuredOn'), t('kpi.value')]}
        rows={actual.map((point) => [shortDate(point.on), measure(point.value, kpi)])}
      />
    </figure>
  );
}

/**
 * A field that reads a measurement at the KPI's own scale.
 *
 * Kept as text while somebody types and only parsed on the way out, for the
 * reason `MoneyInput` is: a number input that reformats mid-keystroke fights
 * whoever is using it, and "99." is a perfectly reasonable thing to have typed
 * so far.
 */
export function MeasureInput({ value, kpi, onChange, ...rest }: {
  value: number | null;
  kpi: Pick<Kpi, 'unit' | 'unit_label' | 'decimals'>;
  onChange: (value: number | null) => void;
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  const decimals = Math.max(0, Math.min(4, Math.round(kpi.decimals) || 0));
  const [text, setText] = useState(() => atScale(value, decimals));
  /*
   * Reseed when the scale changes under it.
   *
   * The text is held locally so typing is not fought, which means it does not
   * follow `decimals` — and `decimals` is editable two fields up on the same
   * form. Changing it left the baseline field showing a figure at the old scale
   * while every other screen had already moved the point. Keyed on the scale
   * rather than on the value, so somebody's half-typed "99." survives a
   * re-render and does not survive a rescale.
   */
  const [scale, setScale] = useState(decimals);
  if (scale !== decimals) {
    setScale(decimals);
    setText(atScale(value, decimals));
  }
  return (
    <Input
      inputMode="decimal"
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        const raw = event.target.value.trim();
        if (!raw) { onChange(null); return; }
        /* `parseMeasure`, not `parseFloat`. The comment above has always said
           this reads at the KPI's own scale; a bare `parseFloat` after swapping
           one comma read "1,200" as 1 and "1.234,56" as 123, so the browser and
           MCP stored the same typed string as different numbers. */
        onChange(parseMeasure(raw, decimals));
      }}
      {...rest}
    />
  );
}

/** A stored integer as the text somebody would have typed to get it. */
const atScale = (value: number | null, decimals: number): string =>
  (value === null || value === undefined ? '' : (value / 10 ** decimals).toFixed(decimals));
