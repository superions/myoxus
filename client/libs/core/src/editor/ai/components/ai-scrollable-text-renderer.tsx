// SPDX-License-Identifier: MIT

import { Scrollable } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";
import throttle from "lodash-es/throttle";
import { useEffect, useMemo, useRef } from "react";

import type {
  MyoxusAIPanelState,
  MyoxusAIPanelWidgetConfig,
} from "../widgets/ai-panel/type";
import { StoredAnswerText } from "./ai-message-content/stored-answer-text";

export interface ScrollableTextRendererOptions {
  host?: EditorHost | null;
}

export function AIScrollableTextRenderer({
  answer,
  state,
  host,
  maxHeight = 320,
  autoScroll = true,
}: {
  answer: string;
  state: MyoxusAIPanelState | undefined;
  host?: EditorHost | null;
  maxHeight?: number;
  autoScroll?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const lastScrollHeightRef = useRef(0);

  const throttledScrollToEnd = useMemo(
    () =>
      throttle(() => {
        requestAnimationFrame(() => {
          const viewport = viewportRef.current;
          if (!viewport) return;
          const scrollHeight = viewport.scrollHeight || 0;
          if (scrollHeight > lastScrollHeightRef.current) {
            lastScrollHeightRef.current = scrollHeight;
            viewport.scrollTo({ top: scrollHeight });
          }
        });
      }, 300),
    [],
  );

  useEffect(() => {
    return () => throttledScrollToEnd.cancel();
  }, [throttledScrollToEnd]);

  useEffect(() => {
    if (autoScroll && (state === "generating" || state === "finished")) {
      throttledScrollToEnd();
    }
  }, [answer, autoScroll, state, throttledScrollToEnd]);

  return (
    <Scrollable.Viewport
      autosize
      scrollbars="y"
      style={{ maxHeight }}
      ref={viewportRef}
      onWheel={(event) => {
        event.stopPropagation();
        if (state === "generating") {
          event.preventDefault();
        }
      }}
    >
      <StoredAnswerText host={host} text={answer} />
    </Scrollable.Viewport>
  );
}

export const createAIScrollableTextRenderer = (
  options: ScrollableTextRendererOptions = {},
  maxHeight = 320,
  autoScroll = true,
): MyoxusAIPanelWidgetConfig["answerRenderer"] => {
  return (answer: string, state: MyoxusAIPanelState | undefined) => (
    <AIScrollableTextRenderer
      answer={answer}
      state={state}
      host={options.host}
      maxHeight={maxHeight}
      autoScroll={autoScroll}
    />
  );
};
