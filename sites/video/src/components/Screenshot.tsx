/**
 * A real screen of the product, cropped in the source's own pixels.
 *
 * Crops are given as a rectangle of the original 2720-wide capture rather than
 * as a percentage or a transform, because that is the one description that
 * survives the screens being re-shot: `{x: 470, y: 0, w: 2250, h: 1160}` still
 * means "the board without the sidebar" at any capture size, and a `scale(1.4)`
 * does not.
 *
 * The box is filled — the larger of the two ratios wins and the crop is centred —
 * so a crop whose aspect is a little off the box's loses its edges instead of
 * stretching. Stretched UI in a marketing video is the tell that the UI is fake.
 */
import React from 'react';
import { Img } from 'remotion';
import { colour, shadow } from '../theme';

export type Crop = { x: number; y: number; w: number; h: number };
export type Source = { src: string; w: number; h: number };

/** Where the image has to sit for `crop` to fill a `width × height` box. */
const place = (screen: Source, crop: Crop, width: number, height: number) => {
  const scale = Math.max(width / crop.w, height / crop.h);
  return {
    position: 'absolute' as const,
    left: width / 2 - (crop.x + crop.w / 2) * scale,
    top: height / 2 - (crop.y + crop.h / 2) * scale,
    width: screen.w * scale,
    height: screen.h * scale,
  };
};

const Pane: React.FC<{
  width: number;
  height: number;
  radius: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ width, height, radius, style, children }) => (
  <div
    style={{
      position: 'absolute',
      width,
      height,
      borderRadius: radius,
      overflow: 'hidden',
      background: colour.bgRaised,
      border: `1px solid ${colour.lineStrong}`,
      boxShadow: shadow,
      ...style,
    }}
  >
    {children}
    {/* The one-pixel light along the top edge that makes a dark panel look lit. */}
    <div
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: radius,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07)',
        pointerEvents: 'none',
      }}
    />
  </div>
);

export const Screenshot: React.FC<{
  screen: Source;
  crop: Crop;
  width: number;
  height: number;
  radius?: number;
  /** Set on the wrapper, so callers can place, scale and fade the whole window. */
  style?: React.CSSProperties;
  /** Drawn on top of the image, inside the same rounded clip. */
  children?: React.ReactNode;
}> = ({ screen, crop, width, height, radius = 18, style, children }) => (
  <Pane width={width} height={height} radius={radius} style={style}>
    <Img src={screen.src} style={place(screen, crop, width, height)} />
    {children}
  </Pane>
);

/**
 * Several screens dissolving inside **one** window.
 *
 * The first version of the layouts beat cross-faded three separate `Screenshot`
 * windows, and every transition showed two borders, two shadows and two
 * sidebars a few pixels apart — a ghost, not a dissolve. One frame with the
 * images swapping inside it is the whole fix: the chrome never moves, which is
 * also exactly the point that beat is making.
 */
export const ScreenshotStack: React.FC<{
  layers: { key: string; screen: Source; opacity: number; scale?: number }[];
  crop: Crop;
  width: number;
  height: number;
  radius?: number;
  style?: React.CSSProperties;
}> = ({ layers, crop, width, height, radius = 18, style }) => (
  <Pane width={width} height={height} radius={radius} style={style}>
    {layers.map((layer) => (
      <Img
        key={layer.key}
        src={layer.screen.src}
        style={{
          ...place(layer.screen, crop, width, height),
          opacity: layer.opacity,
          transform: layer.scale ? `scale(${layer.scale})` : undefined,
        }}
      />
    ))}
  </Pane>
);
