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
import { Headline, Kicker, Rise, Sub } from '../../components/Type';
import { TALL } from '../../components/Layout';

export const Words: React.FC<{ kicker: string; headline: string; sub?: string }> = ({
  kicker,
  headline,
  sub,
}) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 26,
      width: TALL.width,
    }}
  >
    <Rise at={4}>
      <Kicker size={26}>{kicker}</Kicker>
    </Rise>
    <Rise at={9}>
      <Headline size={66}>{headline}</Headline>
    </Rise>
    {sub ? (
      <Rise at={16}>
        <Sub size={30} width={TALL.width}>
          {sub}
        </Sub>
      </Rise>
    ) : null}
  </div>
);
