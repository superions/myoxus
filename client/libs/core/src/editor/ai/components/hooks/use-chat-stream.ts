// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { EditorHost } from "@virgultum/editor/std";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef } from "react";

import { type AIError, AIProvider } from "../../provider";
import { resolveRetryTarget } from "../../utils/chat-turn";
import { mergeStreamObjects } from "../../utils/stream-objects";
import type { AIReasoningConfig } from "../ai-chat-input/type";
import {
  type ChatMessage,
  type HistoryMessage,
  isChatMessage,
  StreamObjectSchema,
} from "../ai-chat-messages/type";

/**
 * Applies one raw SSE chunk to the trailing assistant message in an immutable
 * message list, parsing structured StreamObject JSON when valid and falling
 * back to plain markdown text otherwise.
 */
export function applyChatStreamChunk<T extends HistoryMessage>(
  messages: readonly T[],
  chunk: string,
): T[] {
  const next = messages.slice();
  const tail = next.at(-1);
  if (!tail || !isChatMessage(tail)) return next;

  try {
    const parsed = StreamObjectSchema.parse(JSON.parse(chunk));
    const streamObjects = mergeStreamObjects([
      ...(tail.streamObjects ?? []),
      parsed,
    ]);
    next[next.length - 1] = { ...tail, streamObjects };
  } catch {
    next[next.length - 1] = {
      ...tail,
      content: tail.content + chunk,
    };
  }
  return next;
}

export interface RetryChatTurnParams {
  workspaceId: string;
  docId?: string;
  sessionId?: string;
  ensureSessionId: () => Promise<string | undefined>;
  previousMessages: HistoryMessage[];
  status: string;
  aiModelService?: AIModelService;
  reasoningConfig: AIReasoningConfig;
  aiToolsConfigService: AIToolsConfigService;
  host?: EditorHost | null;
  where: VirgultumPresets.TrackerWhere;
  control: VirgultumPresets.TrackerControl;
  isRootSession?: boolean;
  isScopeStillCurrent: (ownedSessionId: string | undefined) => boolean;
  onPatch: (patch: {
    status?: "idle" | "loading" | "transmitting" | "success" | "error";
    error?: AIError | null;
    messages?: HistoryMessage[];
    abortController?: AbortController | null;
    retrievalAvailable?: boolean | undefined;
  }) => void;
  onCompleted?: () => Promise<void> | void;
}

/**
 * Shared retry streaming hook used by both the main chat view and canvas
 * chat-block peek views to regenerate the trailing assistant turn with
 * cancellation safety and server response-ID reconciliation.
 */
export function useChatStream() {
  const activeRetryRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRetryRef.current?.abort();
      activeRetryRef.current = null;
    };
  }, []);

  const retryTurn = useCallback(async (params: RetryChatTurnParams) => {
    const {
      workspaceId,
      docId,
      sessionId: initialSessionId,
      ensureSessionId,
      previousMessages,
      status,
      aiModelService,
      reasoningConfig,
      aiToolsConfigService,
      host,
      where,
      control,
      isRootSession,
      isScopeStillCurrent,
      onPatch,
      onCompleted,
    } = params;

    if (
      (activeRetryRef.current && !activeRetryRef.current.signal.aborted) ||
      status === "loading" ||
      status === "transmitting" ||
      !AIProvider.actions.chat
    ) {
      return;
    }

    if (
      aiModelService &&
      !aiModelService.supportsVision &&
      previousMessages.some(
        (m) => isChatMessage(m) && m.role === "user" && !!m.attachments?.length,
      )
    ) {
      return;
    }

    const last = previousMessages.at(-1);
    if (!last || !isChatMessage(last) || last.role !== "assistant") return;

    const controller = new AbortController();
    const requestId = nanoid();
    const modelId = aiModelService?.effectiveModelId;
    const reasoning = aiModelService?.reasoningAvailable
      ? !!reasoningConfig.enabled.value
      : undefined;
    const toolsConfig = aiToolsConfigService.config.value;
    let ownedSessionId = initialSessionId;
    let sawOutput = false;
    activeRetryRef.current = controller;

    const isCurrent = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      activeRetryRef.current === controller &&
      isScopeStillCurrent(ownedSessionId);

    onPatch({
      status: "loading",
      error: null,
      abortController: controller,
      retrievalAvailable: undefined,
    });

    try {
      const sessionId = await ensureSessionId();
      ownedSessionId = sessionId;
      if (!isCurrent()) return;
      if (!sessionId) throw new Error("Conversation creation unavailable");
      if (!AIProvider.histories) {
        throw new Error("The original user turn is unavailable");
      }

      const history = await AIProvider.histories.chats(workspaceId, sessionId);
      if (!isCurrent()) return;

      const stored = (history?.[0]?.messages ?? []) as ChatMessage[];
      const { user, response, expectedStreamId } = resolveRetryTarget(
        previousMessages,
        stored,
      );

      let workingMessages: HistoryMessage[] = [
        ...previousMessages.slice(0, -1),
        {
          ...last,
          content: "",
          streamObjects: [],
          createdAt: new Date().toISOString(),
          id: response?.id ?? "",
          params: { requestId },
        },
      ];
      onPatch({ messages: workingMessages });

      const stream = await AIProvider.actions.chat({
        sessionId,
        retry: true,
        requestId,
        messageId: user.id,
        responseId: response?.id,
        expectedStreamId,
        docId,
        workspaceId,
        host: host ?? undefined,
        stream: true,
        signal: controller.signal,
        where,
        control,
        isRootSession,
        modelId,
        reasoning,
        toolsConfig,
        onRetrievalStatus: (available) => {
          if (isCurrent()) onPatch({ retrievalAvailable: available });
        },
      });

      for await (const chunk of stream) {
        if (!isCurrent()) break;
        sawOutput = true;
        workingMessages = applyChatStreamChunk(workingMessages, chunk);
        onPatch({ messages: workingMessages, status: "transmitting" });
      }

      if (!isCurrent()) return;

      const finalHistory = await AIProvider.histories.chats(
        workspaceId,
        sessionId,
      );
      if (!isCurrent()) return;

      const finalMessages = (finalHistory?.[0]?.messages ??
        []) as ChatMessage[];
      const reconciled = finalMessages.find(
        (m) =>
          m.role === "assistant" &&
          m.params?.requestId === requestId &&
          m.params?.responseTo === user.id,
      );
      if (!reconciled) {
        throw new Error(
          "The regenerated response identity could not be reconciled",
        );
      }

      onPatch({
        status: "success",
        messages: [
          ...workingMessages.slice(0, -1),
          {
            ...workingMessages.at(-1)!,
            id: reconciled.id,
            params: reconciled.params,
            generatedFiles: reconciled.generatedFiles,
          },
        ],
      });
      await onCompleted?.();
    } catch (error) {
      if (isCurrent()) {
        onPatch(
          controller.signal.aborted
            ? { status: "idle" }
            : {
                status: "error",
                error: error as AIError,
                ...(!sawOutput ? { messages: previousMessages } : {}),
              },
        );
      }
    } finally {
      if (isCurrent()) {
        onPatch({
          abortController: null,
          ...(controller.signal.aborted ? { status: "idle" } : {}),
        });
      }
      if (activeRetryRef.current === controller) {
        activeRetryRef.current = null;
      }
    }
  }, []);

  const abortRetry = useCallback(() => {
    activeRetryRef.current?.abort();
    activeRetryRef.current = null;
  }, []);

  return { retryTurn, abortRetry };
}
