// SPDX-License-Identifier: MIT

import { Scrollable, Stack, useThrottledCallback } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  MyoxusAIPanelState,
  MyoxusAIPanelWidgetConfig,
} from "../widgets/ai-panel/type";
import { StoredAnswerText } from "./ai-message-content/stored-answer-text";
import { ChatScrollToLatest } from "./message-chrome";

const AUTO_SCROLL_PAUSE_THRESHOLD_PX = 32;
const AUTO_SCROLL_RESUME_THRESHOLD_PX = 16;

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
  const [paused, setPaused] = useState(false);

  const throttledScrollToEnd = useThrottledCallback(() => {
    requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const scrollHeight = viewport.scrollHeight || 0;
      if (scrollHeight > lastScrollHeightRef.current) {
        lastScrollHeightRef.current = scrollHeight;
        viewport.scrollTo({ top: scrollHeight });
      }
    });
  }, 300);

  useEffect(() => {
    if (state !== "generating") {
      setPaused(false);
    }
  }, [state]);

  useEffect(() => {
    if (
      autoScroll &&
      !paused &&
      (state === "generating" || state === "finished")
    ) {
      throttledScrollToEnd();
    }
  }, [answer, autoScroll, paused, state, throttledScrollToEnd]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || state !== "generating") return;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > AUTO_SCROLL_PAUSE_THRESHOLD_PX) {
      setPaused(true);
    } else if (distanceFromBottom <= AUTO_SCROLL_RESUME_THRESHOLD_PX) {
      setPaused(false);
    }
  }, [state]);

  const resumeAutoScroll = useCallback(() => {
    setPaused(false);
    const viewport = viewportRef.current;
    if (!viewport) return;
    lastScrollHeightRef.current = viewport.scrollHeight || 0;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, []);

  return (
    <Stack gap="xs">
      <Scrollable.Viewport
        autosize
        scrollbars="y"
        style={{ maxHeight }}
        ref={viewportRef}
        onScroll={handleScroll}
        onWheel={(event) => {
          event.stopPropagation();
        }}
      >
        <StoredAnswerText host={host} text={answer} />
      </Scrollable.Viewport>
      {paused && state === "generating" ? (
        <ChatScrollToLatest onClick={resumeAutoScroll} />
      ) : null}
    </Stack>
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
