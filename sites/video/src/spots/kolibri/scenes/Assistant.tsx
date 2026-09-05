/**
 * The MCP beat: a tool call on the right, and the task it files under it. The
 * console and its arguments live in `components/ToolCall.tsx`.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../copy';
import { colour } from '../../../theme';
import { presence, ramp, span } from '../../../components/anim';
import { Headline, Kicker, Rise, Sub } from '../../../components/Type';
import { TextColumn } from '../../../components/Layout';
import { ToolCall, TOOL_CALL } from '../../../components/ToolCall';
import { TaskCard } from '../../../components/ui';

export const Assistant: React.FC<{ life: number }> = ({ life }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TextColumn width={620}>
        <Rise at={4}>
          <Kicker>{beats.assistant.kicker}</Kicker>
        </Rise>
        <Rise at={9}>
          <Headline>{beats.assistant.headline}</Headline>
        </Rise>
        <Rise at={18}>
          <Sub width={600}>{beats.assistant.sub}</Sub>
        </Rise>
      </TextColumn>

      <ToolCall frame={frame} width={1014} size={22} style={{ left: 806, top: 224 }} />

      <div
        style={{
          position: 'absolute',
          left: 806,
          top: 664,
          opacity: ramp(frame, TOOL_CALL.filed, 16),
          transform: `translateY(${span(frame, TOOL_CALL.filed, 22, 24, 0)}px)`,
        }}
      >
        <TaskCard
          id="WEB-4"
          title="Cut largest-contentful-paint below 1.5s"
          priority={4}
          chips={[
            { label: 'performance', dot: colour.accent },
            { label: 'Cycle 2026-8' },
            { label: 'Aug 30' },
          ]}
          width={660}
        />
      </div>
    </AbsoluteFill>
  );
};
