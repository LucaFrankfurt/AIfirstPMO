/**
 * Six switches, all off, and a sidebar that grows only when one is turned on.
 *
 * `WorkspaceFeatures` in the shared registry is emphatic about the default:
 * "Off by default, all of it. A feature that is on for everybody until they
 * find the switch is a feature that has already cluttered the screen of every
 * team that did not want it — and the ones who do want it are the ones who will
 * go looking."
 *
 * The last movement is the one that matters and is the reason this is animated
 * rather than listed: one switch goes back off, its screens leave the sidebar,
 * and the counter under it says that nothing was deleted. A workspace that
 * turns budgets back on finds its figures where it left them.
 */
import React from 'react';
import { colour, font } from '../theme';
import { ramp, span } from './anim';
import { Panel, Toggle } from './ui';

const FEATURES = [
  { key: 'time', name: 'Time', screen: 'Time', on: 26 },
  { key: 'budget', name: 'Budgets', screen: 'Budgets', on: 44, off: 150 },
  { key: 'infrastructure', name: 'Infrastructure', screen: 'Estate', on: 62 },
  { key: 'kpi', name: 'KPIs', screen: 'KPIs', on: 80 },
  { key: 'ai', name: 'AI review', screen: 'Review', on: 98 },
  { key: 'mail', name: 'Mail', screen: 'Inboxes', on: 116 },
] as const;

/** What every workspace has whether or not it has decided anything. */
const ALWAYS = ['My work', 'Inbox', 'Search', 'Chat', 'Pages'];

export const FEATURES_AT = { untouched: 168 };

export const FeatureSwitches: React.FC<{
  frame: number;
  width: number;
  size: number;
  /** Side by side in 16:9; the sidebar under the switches in 9:16. */
  stacked?: boolean;
  style?: React.CSSProperties;
}> = ({ frame, width, size, stacked = false, style }) => {
  const state = (f: (typeof FEATURES)[number]) =>
    ramp(frame, f.on, 12) * (1 - ('off' in f ? ramp(frame, f.off, 12) : 0));

  const column = stacked ? width : width * 0.56;
  const rail = stacked ? width : width * 0.4;

  return (
    <div
      style={{
        position: 'absolute',
        width,
        textAlign: 'left',
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        gap: size,
        opacity: ramp(frame, 2, 16),
        transform: `translateY(${span(frame, 2, 22, 18, 0)}px)`,
        ...style,
      }}
    >
      <Panel label="Features" size={size} style={{ width: column }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: size * 0.55 }}>
          {FEATURES.map((feature) => {
            const on = state(feature);
            return (
              <div key={feature.key} style={{ display: 'flex', alignItems: 'center', gap: size * 0.7 }}>
                <Toggle on={on} size={size} />
                <span
                  style={{
                    font: `500 ${size * 0.98}px/1 ${font.sans}`,
                    color: on > 0.5 ? colour.fg : colour.fgMuted,
                    flex: 1,
                  }}
                >
                  {feature.name}
                </span>
                <span
                  style={{
                    font: `400 ${size * 0.82}px/1 ${font.mono}`,
                    color: on > 0.5 ? colour.ok : colour.fgMuted,
                  }}
                >
                  {on > 0.5 ? 'on' : 'off'}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel label="Sidebar" size={size} style={{ width: rail }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {ALWAYS.map((item) => (
            <span
              key={item}
              style={{
                padding: `${size * 0.42}px 0`,
                font: `400 ${size * 0.95}px/1 ${font.sans}`,
                color: colour.fgSoft,
              }}
            >
              {item}
            </span>
          ))}
          {FEATURES.map((feature) => {
            const on = state(feature);
            return (
              <span
                key={feature.key}
                style={{
                  height: on * size * 1.79,
                  overflow: 'hidden',
                  opacity: on,
                  display: 'flex',
                  alignItems: 'center',
                  font: `400 ${size * 0.95}px/1 ${font.sans}`,
                  color: colour.accentText,
                  transform: `translateX(${(1 - on) * -14}px)`,
                }}
              >
                {feature.screen}
              </span>
            );
          })}
        </div>

        <div
          style={{
            marginTop: size * 0.8,
            paddingTop: size * 0.7,
            borderTop: `1px solid ${colour.line}`,
            font: `400 ${size * 0.85}px/1.45 ${font.sans}`,
            color: colour.fgMuted,
            opacity: ramp(frame, FEATURES_AT.untouched, 16),
          }}
        >
          <span style={{ color: colour.ok, fontWeight: 700 }}>Budgets off · 0 rows touched.</span>{' '}
          Switching it off hides the screens. Turn it back on and the figures are where you left them.
        </div>
      </Panel>
    </div>
  );
};
