/**
 * One beat, in either shape, from one file.
 *
 * The flagship spot has a wide layout and a tall layout written out separately,
 * because half its beats are screenshots whose crops genuinely differ. The two
 * explainer spots are not like that: every beat is words plus one animated
 * widget, and the only thing that changes between 16:9 and 9:16 is whether the
 * words sit beside the widget or above it. Writing that out twice would be
 * fourteen files saying the same thing in two column orders.
 *
 * So a scene renders `<Beat>` and hands it the widget, sized for the shape it
 * was given. The widget is positioned at `{ left: 0, top: 0 }` inside a box of
 * exactly the size the scene asked for — which is why every widget in this
 * folder takes a `width` and a `style` rather than deciding where it lives.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { presence } from './anim';
import { Headline, Kicker, Rise, Sub } from './Type';
import { STACKED, Slot, TextColumn, type Stacked } from './Layout';

/**
 * Three shapes, two arrangements. 4:5 stacks exactly as 9:16 does — same width,
 * same widgets, same order — on a shorter budget, which is why it is a shape
 * here rather than a third set of layouts.
 */
export type Shape = 'wide' | 'tall' | 'feed';

export interface Words {
  kicker: string;
  headline: string;
  sub?: string;
}

/** Where the widget goes, per shape. A scene gives both and `Beat` picks one. */
export interface Visual {
  width: number;
  height: number;
}

export const Beat: React.FC<{
  shape: Shape;
  life: number;
  words: Words;
  wide: Visual & { left?: number; top?: number };
  tall: Visual & { gap?: number };
  children: React.ReactNode;
}> = ({ shape, life, words, wide, tall, children }) => {
  const frame = useCurrentFrame();
  const fade = presence(frame, life);

  if (shape === 'wide') {
    return (
      <AbsoluteFill style={{ opacity: fade }}>
        <TextColumn width={620}>
          <Rise at={4}>
            <Kicker>{words.kicker}</Kicker>
          </Rise>
          <Rise at={9}>
            <Headline>{words.headline}</Headline>
          </Rise>
          {words.sub ? (
            <Rise at={18}>
              <Sub width={600}>{words.sub}</Sub>
            </Rise>
          ) : null}
        </TextColumn>
        <div
          style={{
            position: 'absolute',
            left: wide.left ?? 806,
            /* Vertically centred on the frame unless the scene says otherwise. */
            top: wide.top ?? (1080 - wide.height) / 2,
            width: wide.width,
            height: wide.height,
          }}
        >
          {children}
        </div>
      </AbsoluteFill>
    );
  }

  const box = STACKED[shape as Stacked];
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: box.top,
          bottom: box.bottom,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: tall.gap ?? box.gap,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: box.kicker,
            width: box.width,
          }}
        >
          <Rise at={4}>
            <Kicker size={box.kicker}>{words.kicker}</Kicker>
          </Rise>
          <Rise at={9}>
            <Headline size={box.headline}>{words.headline}</Headline>
          </Rise>
          {words.sub ? (
            <Rise at={16}>
              <Sub size={box.sub} width={box.width}>
                {words.sub}
              </Sub>
            </Rise>
          ) : null}
        </div>
        {/*
         * The widget keeps the size the scene asked for: 4:5 and 9:16 are both
         * 1080 across, so only the words and the spacing have to give.
         */}
        <Slot width={tall.width} height={tall.height}>
          {children}
        </Slot>
      </div>
    </AbsoluteFill>
  );
};
