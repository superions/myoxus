// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Stack } from "@myoxus/ui-facade";
import { Fragment, useMemo, type ReactNode } from "react";

import { mergeStreamObjects } from "../../utils/stream-objects";
import type { MyoxusAIPanelState } from "../../widgets/ai-panel/type";
import type { StreamObject } from "../ai-chat-messages";
import { ReasoningSection } from "./reasoning";

export interface StreamPartsProps {
  answer: readonly StreamObject[];
  state: MyoxusAIPanelState;
  showReasoning: boolean;
  reasoningIdentity?: ReactNode;
  renderText: (text: string, annotation?: boolean) => ReactNode;
  renderTool: (
    data: Extract<StreamObject, { type: "tool-call" | "tool-result" }>,
  ) => ReactNode;
}

/**
 * Projects a merged sequence of text, reasoning, and tool-call/result parts.
 * Tool entries key by `toolCallId` so upgrading a call to a result preserves
 * open preview panels and sandbox instances.
 */
export function StreamParts({
  answer,
  state,
  showReasoning,
  reasoningIdentity,
  renderText,
  renderTool,
}: StreamPartsProps) {
  const parts = useMemo(() => mergeStreamObjects(answer), [answer]);

  return (
    <Stack gap="xs">
      {parts.map((part, idx) => {
        if (part.type === "text-delta") {
          return (
            <Fragment key={`text-${idx}`}>
              {renderText(part.textDelta)}
            </Fragment>
          );
        }
        if (part.type === "reasoning") {
          if (!showReasoning) return null;
          return (
            <ReasoningSection
              key={`reasoning-${idx}`}
              identity={idx === 0 ? reasoningIdentity : undefined}
              followedByContent={idx < parts.length - 1}
              generating={state === "generating" && idx === parts.length - 1}
            >
              {renderText(part.textDelta, true)}
            </ReasoningSection>
          );
        }
        if (part.type === "tool-call" || part.type === "tool-result") {
          return <Fragment key={part.toolCallId}>{renderTool(part)}</Fragment>;
        }
        return null;
      })}
    </Stack>
  );
}
