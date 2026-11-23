import { Stack } from "@myoxus/ui-facade";
import { createElement, Fragment, useMemo, type ReactNode } from "react";
import { mergeStreamObjects } from "../../utils/stream-objects";
import type { MyoxusAIPanelState } from "../../widgets/ai-panel/type";
import type { StreamObject } from "../ai-chat-messages";
import { ReasoningSection } from "./reasoning";

export function StreamParts({
  answer,
  state,
  showReasoning,
  reasoningIdentity,
  renderText,
  renderTool,
}: {
  answer: readonly StreamObject[];
  state: MyoxusAIPanelState;
  showReasoning: boolean;
  reasoningIdentity?: ReactNode;
  renderText: (text: string, annotation?: boolean) => ReactNode;
  renderTool: (
    data: Extract<StreamObject, { type: "tool-call" | "tool-result" }>,
  ) => ReactNode;
}) {
  // A call and its result share the same key, so replacing streamed data does
  // not close its preview or dispose the active sandbox.
  const parts = useMemo(() => mergeStreamObjects([...answer]), [answer]);
  return createElement(
    Stack,
    { gap: "xs" },
    parts.map((data, index) => {
      switch (data.type) {
        case "text-delta":
          return createElement(
            Fragment,
            { key: index },
            renderText(data.textDelta),
          );
        case "reasoning":
          return showReasoning
            ? createElement(
                ReasoningSection,
                {
                  key: index,
                  identity: index === 0 ? reasoningIdentity : undefined,
                  followedByContent: index < parts.length - 1,
                  generating:
                    state === "generating" && index === parts.length - 1,
                },
                renderText(data.textDelta, true),
              )
            : null;
        case "tool-call":
        case "tool-result":
          return createElement(
            Fragment,
            { key: data.toolCallId },
            renderTool(data),
          );
        default:
          return null;
      }
    }),
  );
}
