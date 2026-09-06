/**
 * The tool call and the task it files, stacked.
 *
 * At 20px the longest line — `title      "Cut largest-contentful-paint below
 * 1.5s"` — is 612px plus padding, so the console can be 1000 wide and still
 * have the argument column line up. Wrapping any of those lines would turn a
 * tool call into a paragraph.
 */
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { beats } from '../../copy';
import { colour } from '../../../../theme';
import { presence, ramp, span } from '../../../../components/anim';
import { Slot, TallStack, type Stacked } from '../../../../components/Layout';
import { ToolCall, TOOL_CALL } from '../../../../components/ToolCall';
import { TaskCard } from '../../../../components/ui';
import { Words } from './Words';

export const AssistantTall: React.FC<{ shape: Stacked; life: number }> = ({ shape, life }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ opacity: presence(frame, life) }}>
      <TallStack shape={shape} gap={64}>
        <Words shape={shape} {...beats.assistant} />

        <Slot width={1000} height={334}>
          <ToolCall frame={frame} width={1000} size={20} style={{ left: 0, top: 0 }} />
        </Slot>

        <div
          style={{
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
            width={880}
          />
        </div>
      </TallStack>
    </AbsoluteFill>
  );
};
