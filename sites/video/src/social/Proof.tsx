/**
 * Every slide of one carousel, on one sheet.
 *
 * This is a tool, not an asset, and it exists because of how the first set went
 * wrong. A carousel is checked the way it is read — in order, one slide at a
 * time — and looking at eight 1080×1350 PNGs one after another is exactly the
 * way to miss the thing that is actually wrong with a set: that slide four is
 * half empty while slide five is crammed, or that the headline sits at a
 * different height on three of them. Those are comparisons, and a comparison
 * needs both things in the eye at once.
 *
 * So: `npm run social:proof` renders one wide frame per carousel with the whole
 * deck laid out on it, scaled down and numbered. Nothing about it is published.
 * It is what somebody looks at before they post.
 */
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { colour, font } from '../theme';
import { POST } from './sheet';
import { SlideView } from './Slide';
import type { Slide } from './slide';

/** Four across, because five is where a 1080-wide slide stops being readable. */
export const COLUMNS = 4;
const SCALE = 0.44;
const GAP = 26;

const CELL = { width: POST.width * SCALE, height: POST.height * SCALE };

/** The frame a proof sheet for `count` slides needs. Used by `Root` to size it. */
export const proofSize = (count: number) => {
  const columns = Math.min(COLUMNS, count);
  const rows = Math.ceil(count / columns);
  return {
    width: Math.round(GAP + columns * (CELL.width + GAP)),
    height: Math.round(GAP + rows * (CELL.height + GAP + 34)),
  };
};

export const proof = (slides: readonly Slide[], series = true): React.FC => {
  const Proof: React.FC = () => (
    <AbsoluteFill style={{ background: '#000', padding: GAP, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: GAP }}>
        {slides.map((slide, index) => (
          <div key={index} style={{ width: CELL.width }}>
            <div
              style={{
                width: CELL.width,
                height: CELL.height,
                position: 'relative',
                overflow: 'hidden',
                borderRadius: 10,
                /* A hairline, so a slide that is nearly all background still
                 * has an edge and the balance of the set can be seen at all. */
                outline: `1px solid ${colour.line}`,
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  width: POST.width,
                  height: POST.height,
                  transform: `scale(${SCALE})`,
                  transformOrigin: 'top left',
                }}
              >
                <SlideView
                  slide={slide}
                  index={index}
                  count={slides.length}
                  series={series}
                />
              </div>
            </div>
            <div
              style={{
                padding: '9px 2px 0',
                font: `500 17px/1 ${font.mono}`,
                color: colour.fgMuted,
              }}
            >
              {index + 1} · {slide.kind}
            </div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
  return Proof;
};
