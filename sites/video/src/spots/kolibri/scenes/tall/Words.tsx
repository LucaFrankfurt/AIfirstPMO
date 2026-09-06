/**
 * The kicker/headline/sub block, at the vertical cut's sizes.
 *
 * Every 9:16 beat opens with exactly this, so it is one component rather than
 * seven copies of three `<Rise>`s. The sizes are bigger than the wide cut's in
 * absolute pixels and much bigger relative to the frame — 66px on a 1080-wide
 * canvas is 6% of the width against 3% for the same headline at 1920, which is
 * roughly what it takes to stay readable on a phone held at arm's length.
 */
import React from 'react';
import { Headline, Kicker, Rise, Sub } from '../../../../components/Type';
import { STACKED, type Stacked } from '../../../../components/Layout';

export const Words: React.FC<{
  shape: Stacked;
  kicker: string;
  headline: string;
  sub?: string;
}> = ({ shape, kicker, headline, sub }) => {
  const box = STACKED[shape];
  return (
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
      <Kicker size={box.kicker}>{kicker}</Kicker>
    </Rise>
    <Rise at={9}>
      <Headline size={box.headline}>{headline}</Headline>
    </Rise>
    {sub ? (
      <Rise at={16}>
        <Sub size={box.sub} width={box.width}>
          {sub}
        </Sub>
      </Rise>
    ) : null}
  </div>
  );
};
