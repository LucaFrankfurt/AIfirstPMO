/**
 * A chart, written as a fenced block of JSON, drawn as HTML.
 *
 * ```chart
 * {"type": "bar", "title": "Bookings", "labels": ["Sep", "Oct"], "series": [{"name": "2026", "values": [12, 19]}]}
 * ```
 *
 * Written for whoever types a message — a person in the team chat, the support
 * assistant answering a visitor — and so it is the smallest spec that says what
 * a chart in a message says: bars or a line, the categories along the bottom,
 * one to three series of numbers. A model can write it from a table it was
 * given; a person can write it without a manual.
 *
 * Drawn in HTML and CSS rather than as one scaled SVG, for the reason the app's
 * other charts are (`.chart-*` in `app.css`): an SVG scaled to a chat bubble
 * scales its text with it, and an axis label at 280 pixels wide came out at six
 * pixels high. Only the line itself is a stretched SVG, and it is drawn with a
 * stroke that does not stretch.
 *
 * Nothing here runs: no script, no event, no external fetch. The hover is the
 * browser's own `title`, and the numbers are always there as a table under the
 * chart — colour is never the only way a figure is carried, and the green the
 * second series wears is below 3:1 on white (measured with the data-viz
 * palette check), which is exactly the case that rule exists for.
 *
 * A block that is not a chart this understands — bad JSON, a fourth series, a
 * value that is not a number — is shown as the code it is. A chart drawn from a
 * guess at what was meant would be a picture of numbers nobody wrote.
 */
import { escapeHtml } from './escape.ts';

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartSpec {
  type: 'bar' | 'line';
  title: string | null;
  unit: string | null;
  labels: string[];
  series: ChartSeries[];
}

/**
 * At most three series: the three colours that stay apart for every kind of
 * colour vision, checked against both surfaces. A fourth is not a colour this
 * app has; it is a second chart or a table.
 */
export const CHART_SERIES_MAX = 3;
/** Categories along the bottom: past this a chart in a message is a table. */
export const CHART_LABELS_MAX = 24;

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;

/** The spec in a `chart` block, or null when it is not one. */
export function parseChart(source: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  const type = spec.type === undefined ? 'bar' : spec.type;
  if (type !== 'bar' && type !== 'line') return null;
  const labels = spec.labels;
  if (!Array.isArray(labels) || !labels.length || labels.length > CHART_LABELS_MAX) return null;
  if (!labels.every((label) => typeof label === 'string' || typeof label === 'number')) return null;
  const series = spec.series;
  if (!Array.isArray(series) || !series.length || series.length > CHART_SERIES_MAX) return null;
  const parsed: ChartSeries[] = [];
  for (const [index, one] of series.entries()) {
    if (!one || typeof one !== 'object') return null;
    const values = (one as Record<string, unknown>).values;
    if (!Array.isArray(values) || values.length !== labels.length) return null;
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    parsed.push({ name: text((one as Record<string, unknown>).name, 60) ?? `${index + 1}`, values: values as number[] });
  }
  return {
    type,
    title: text(spec.title, 120),
    unit: text(spec.unit, 12),
    labels: labels.map((label) => String(label).trim().slice(0, 40)),
    series: parsed,
  };
}

/** The next round number at or above a magnitude: 1, 2, 2.5 or 5 times a power of ten. */
function niceCeil(value: number): number {
  if (value <= 0) return 0;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => value <= candidate * power + 1e-9) ?? 10;
  return step * power;
}

export interface ChartOptions {
  /** What the table under the chart is called, in the reader's language. */
  tableLabel?: string;
  /** How numbers are written, e.g. `de` for `1.250,5`. The runtime's own when left out. */
  locale?: string;
}

/** The chart as HTML: title, legend, plot, axis, and the same numbers as a table. */
export function chartHtml(spec: ChartSpec, options: ChartOptions = {}): string {
  const format = new Intl.NumberFormat(options.locale, { maximumFractionDigits: 2 });
  const number = (value: number) => `${format.format(value)}${spec.unit ? ` ${spec.unit}` : ''}`;
  const all = spec.series.flatMap((one) => one.values);
  const hi = niceCeil(Math.max(0, ...all)) || (Math.min(...all) < 0 ? 0 : 1);
  const lo = Math.min(...all) < 0 ? -niceCeil(-Math.min(...all)) : 0;
  const span = hi - lo || 1;
  const at = (value: number) => ((value - lo) / span) * 100;
  const pct = (value: number) => `${Math.round(value * 100) / 100}%`;
  const labels = spec.labels.map(escapeHtml);
  const count = spec.labels.length;
  // Every label when they fit; every n-th when there are many, so a year of
  // months still reads at the width of a chat bubble.
  const every = Math.ceil(count / 6);
  const title = spec.title ?? (spec.series.length === 1 ? spec.series[0].name : null);
  const tip = (index: number) => escapeHtml(
    `${spec.labels[index]}: ${spec.series.map((one) => `${spec.series.length > 1 ? `${one.name} ` : ''}${number(one.values[index])}`).join(', ')}`,
  );
  const bars = spec.type === 'bar' ? count * spec.series.length : 0;

  const parts: string[] = [`<figure class="md-chart" data-chart="${spec.type}"${title ? ` aria-label="${escapeHtml(title)}"` : ''}>`];
  if (title) parts.push(`<figcaption class="md-chart-title">${escapeHtml(title)}</figcaption>`);
  // A legend for two or three series; one series is named by the title.
  if (spec.series.length > 1) {
    parts.push('<div class="md-chart-legend">', ...spec.series.map((one, index) =>
      `<span><i class="md-s${index + 1}"></i>${escapeHtml(one.name)}</span>`), '</div>');
  }
  // The scale is three numbers at most — top, bottom, and zero when the bars
  // cross it — each at its own height, not a ladder of gridlines.
  const ticks = [hi, ...(lo < 0 ? [0] : []), lo];
  parts.push('<div class="md-chart-frame" aria-hidden="true">',
    `<div class="md-chart-scale">${ticks.map((tick) => `<span style="bottom:${pct(at(tick))}">${escapeHtml(number(tick))}</span>`).join('')}</div>`,
    '<div class="md-chart-plot">');
  if (lo < 0) parts.push(`<i class="md-chart-zero" style="bottom:${pct(at(0))}"></i>`);

  if (spec.type === 'bar') {
    for (let index = 0; index < count; index++) {
      parts.push(`<div class="md-chart-group" title="${tip(index)}">`);
      for (const [n, one] of spec.series.entries()) {
        const value = one.values[index];
        const from = at(Math.min(value, 0));
        const height = (Math.abs(value) / span) * 100;
        parts.push(`<span class="md-chart-slot"><span class="md-chart-bar md-s${n + 1}${value < 0 ? ' md-neg' : ''}" style="bottom:${pct(from)};height:${pct(height)}">`
          // A number on each bar while there are few enough to read; past
          // that the table and the hover carry them.
          + (bars <= 12 ? `<b>${escapeHtml(number(value))}</b>` : '')
          + '</span></span>');
      }
      parts.push('</div>');
    }
  } else {
    const x = (index: number) => ((index + 0.5) / count) * 100;
    parts.push('<svg class="md-chart-lines" viewBox="0 0 100 100" preserveAspectRatio="none">');
    for (const [n, one] of spec.series.entries()) {
      const points = one.values.map((value, index) => `${Math.round(x(index) * 100) / 100},${Math.round((100 - at(value)) * 100) / 100}`).join(' ');
      parts.push(`<polyline class="md-s${n + 1}" points="${points}" vector-effect="non-scaling-stroke"></polyline>`);
    }
    parts.push('</svg>');
    for (const [n, one] of spec.series.entries()) {
      for (const [index, value] of one.values.entries()) {
        // The last value, for one line: with two or three their ends crowd
        // into one another, and the legend and the table carry them.
        const last = index === count - 1 && spec.series.length === 1;
        parts.push(`<span class="md-chart-dot md-s${n + 1}" style="left:${pct(x(index))};bottom:${pct(at(value))}">`
          + (last ? `<b>${escapeHtml(number(value))}</b>` : '')
          + '</span>');
      }
    }
    // The hover, one column per category, over the whole height.
    for (let index = 0; index < count; index++) {
      parts.push(`<span class="md-chart-hit" style="left:${pct((index / count) * 100)};width:${pct(100 / count)}" title="${tip(index)}"></span>`);
    }
  }
  parts.push('</div>', '<div class="md-chart-axis">',
    ...labels.map((label, index) => `<span>${index % every === 0 ? label : ''}</span>`), '</div></div>');

  // The same numbers, as text: what a screen reader reads, and what anybody
  // reads who cannot tell the colours apart.
  parts.push(`<details class="md-chart-table"><summary>${escapeHtml(options.tableLabel ?? 'Table')}</summary><table>`,
    `<thead><tr><th></th>${spec.series.map((one) => `<th>${escapeHtml(one.name)}</th>`).join('')}</tr></thead><tbody>`,
    ...labels.map((label, index) =>
      `<tr><th>${label}</th>${spec.series.map((one) => `<td>${escapeHtml(number(one.values[index]))}</td>`).join('')}</tr>`),
    '</tbody></table></details>', '</figure>');
  return parts.join('');
}

/**
 * Every chart in a text written out as lines of numbers, for where nothing
 * draws: the plain-text email that follows a support answer to a visitor who
 * left. A block that is not a chart stays as it was, as it would on screen.
 */
export function chartsAsText(source: string, locale?: string): string {
  return String(source ?? '').replace(/^```chart[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm, (block, body: string) => {
    const spec = parseChart(body);
    if (!spec) return block;
    const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    const number = (value: number) => `${format.format(value)}${spec.unit ? `\u202f${spec.unit}` : ''}`;
    return [
      ...(spec.title ? [spec.title] : []),
      ...spec.labels.map((label, index) => `${label}: ${spec.series
        .map((one) => `${spec.series.length > 1 ? `${one.name} ` : ''}${number(one.values[index])}`).join(', ')}`),
    ].join('\n');
  });
}
