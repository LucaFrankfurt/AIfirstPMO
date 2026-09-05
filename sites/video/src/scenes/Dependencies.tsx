/**
 * The drag, under a lower third. The gantt and its whole animation live in
 * `components/Gantt.tsx`; this file only decides how big it is and where.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { presence } from '../components/anim';
import { Headline, Kicker, Rise, Sub } from '../components/Type';
import { TextBand } from '../components/Layout';
import { Gantt } from '../components/Gantt';

export const Dependencies: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <Gantt
        frame={frame}
        labelWidth={480}
        day={22}
        rowHeight={86}
        headHeight={58}
        labelSize={24}
        style={{ left: 230, top: 200 }}
      />

      <TextBand top={690}>
        <Rise at={4}>
          <Kicker>{beats.timeline.kicker}</Kicker>
        </Rise>
        <Rise at={9}>
          <Headline>{beats.timeline.headline}</Headline>
        </Rise>
        <Rise at={16}>
          <Sub width={980}>{beats.timeline.sub}</Sub>
        </Rise>
      </TextBand>
    </AbsoluteFill>
  );
};
