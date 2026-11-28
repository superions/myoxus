// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { Scrollable, Stack, useThrottledCallback } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  MyoxusAIPanelState,
  MyoxusAIPanelWidgetConfig,
} from "../widgets/ai-panel/type";
import { StoredAnswerText } from "./ai-message-content/stored-answer-text";
import { ChatScrollToLatest } from "./message-chrome";

const PAUSE_THRESHOLD_PX = 32;
const RESUME_THRESHOLD_PX = 16;

export interface ScrollableTextRendererOptions {
  host?: EditorHost | null;
}

/**
 * Renders streaming or completed AI markdown inside a bounded Mantine
 * Scrollable viewport. Scrolling upward pauses auto-scroll without blocking
 * wheel input; the scroll-to-latest control resumes following the tail.
 */
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
  const lastHeightRef = useRef(0);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);

  const updatePaused = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPaused(next);
  }, []);

  const scrollToTail = useThrottledCallback(() => {
    requestAnimationFrame(() => {
      if (pausedRef.current) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      if (viewport.scrollHeight > lastHeightRef.current) {
        lastHeightRef.current = viewport.scrollHeight;
        viewport.scrollTo({ top: viewport.scrollHeight });
      }
    });
  }, 300);

  useEffect(() => {
    if (state !== "generating") {
      lastHeightRef.current = 0;
      updatePaused(false);
    }
  }, [state, updatePaused]);

  useEffect(() => {
    if (
      autoScroll &&
      !paused &&
      (state === "generating" || state === "finished")
    ) {
      scrollToTail();
    }
  }, [answer, autoScroll, paused, scrollToTail, state]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || state !== "generating") return;
    const remaining =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (remaining > PAUSE_THRESHOLD_PX) {
      updatePaused(true);
    } else if (remaining <= RESUME_THRESHOLD_PX) {
      updatePaused(false);
    }
  }, [state, updatePaused]);

  const resume = useCallback(() => {
    updatePaused(false);
    const viewport = viewportRef.current;
    if (!viewport) return;
    lastHeightRef.current = viewport.scrollHeight;
    viewport.scrollTo({ top: viewport.scrollHeight });
  }, [updatePaused]);

  return (
    <Stack gap="xs">
      <Scrollable.Viewport
        autosize
        scrollbars="y"
        style={{ maxHeight }}
        ref={viewportRef}
        onScroll={handleScroll}
        onWheel={(event) => event.stopPropagation()}
      >
        <StoredAnswerText host={host} text={answer} />
      </Scrollable.Viewport>
      {paused && state === "generating" ? (
        <ChatScrollToLatest onClick={resume} />
      ) : null}
    </Stack>
  );
}

export function createAIScrollableTextRenderer(
  options: ScrollableTextRendererOptions = {},
  maxHeight = 320,
  autoScroll = true,
): MyoxusAIPanelWidgetConfig["answerRenderer"] {
  return (answer, state) => (
    <AIScrollableTextRenderer
      answer={answer}
      state={state}
      host={options.host}
      maxHeight={maxHeight}
      autoScroll={autoScroll}
    />
  );
}
