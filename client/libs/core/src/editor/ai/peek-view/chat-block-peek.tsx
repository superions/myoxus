// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { i18nTime } from "@myoxus/i18n";
import { MyoxusText, Stack, useThrottledCallback } from "@myoxus/ui-facade";
import {
  CanvasElementType,
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
} from "@virgultum/editor/blocks/surface";
import { ConnectorMode } from "@virgultum/editor/model";
import {
  DocModeProvider,
  NotificationProvider,
  TelemetryProvider,
} from "@virgultum/editor/shared/services";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ChatBlockPeekViewActions,
  constructUserInfoWithMessages,
  queryHistoryMessages,
} from "../_common/chat-actions-handle";
import type { AIChatBlockModel } from "../blocks";
import { StoredChatMessages } from "../blocks/ai-chat-block/components/stored-chat-messages";
import type { SearchMenuConfig } from "../components/ai-chat-add-context";
import type { DocDisplayConfig } from "../components/ai-chat-chips";
import { AIChatComposer } from "../components/ai-chat-composer/ai-chat-composer";
import type {
  AIChatInputContext,
  AIReasoningConfig,
} from "../components/ai-chat-input";
import {
  type ChatMessage,
  ChatMessagesSchema,
  type ChatStatus,
  StreamObjectSchema,
} from "../components/ai-chat-messages";
import { AIHistoryClear } from "../components/ai-history-clear/ai-history-clear";
import { collectToolCreatedFileIds } from "../components/ai-tools/create-file-tool";
import { useChatStream } from "../components/hooks/use-chat-stream";
import {
  ChatLoading,
  ChatPeekConversation,
} from "../components/message-chrome";
import { CopilotResponseActions } from "../components/response-actions";
import { AIChatErrorRenderer } from "../messages/error";
import { type AIError, AIProvider } from "../provider";
import { mergeStreamContent } from "../utils/stream-objects";
import { computeBranchChatBound } from "./child-bound";

const PEEK_TRACKING = {
  where: "ai-chat-block",
  control: "chat-send",
} as const;

interface PeekChatState {
  messages: ChatMessage[];
  status: ChatStatus;
  error: AIError | null;
  images: File[];
  abortController: AbortController | null;
}

const EMPTY_PEEK_STATE: PeekChatState = {
  messages: [],
  status: "idle",
  error: null,
  images: [],
  abortController: null,
};

export interface ChatBlockPeekProps {
  blockModel: AIChatBlockModel;
  peekViewService: PeekViewService;
  host: EditorHost;
  reasoningConfig: AIReasoningConfig;
  docDisplayConfig: DocDisplayConfig;
  searchMenuConfig: SearchMenuConfig;
  aiToolsConfigService: AIToolsConfigService;
  aiModelService: AIModelService;
}

function parseSnapshotMessages(serialized: string): ChatMessage[] {
  try {
    const parsed = ChatMessagesSchema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Interactive peek view for persisted `myoxus:embed-ai-chat` canvas blocks.
 * Displays the saved snapshot history and forks follow-up prompts into a
 * connected child chat block on the edgeless surface.
 */
export function ChatBlockPeek({
  blockModel,
  peekViewService,
  host,
  reasoningConfig,
  docDisplayConfig,
  searchMenuConfig,
  aiToolsConfigService,
  aiModelService,
}: ChatBlockPeekProps) {
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>(() =>
    parseSnapshotMessages(blockModel.props.messages),
  );
  const [chatState, setChatState] = useState<PeekChatState>(EMPTY_PEEK_STATE);
  const [session, setSession] = useState<CopilotChatHistoryFragment | null>();
  const [forkSession, setForkSession] =
    useState<CopilotChatHistoryFragment | null>();

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const forkBlockIdRef = useRef<string | undefined>(undefined);
  const historyRef = useRef(historyMessages);
  historyRef.current = historyMessages;
  const chatStateRef = useRef(chatState);
  chatStateRef.current = chatState;
  const forkSessionRef = useRef(forkSession);
  forkSessionRef.current = forkSession;

  const { retryTurn, abortRetry } = useChatStream();
  const notificationService = useMemo(
    () => host.std.get(NotificationProvider),
    [host],
  );

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = viewportRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  }, []);
  const throttledScrollToEnd = useThrottledCallback(scrollToEnd, 600);

  const updateState = useCallback((patch: Partial<AIChatInputContext>) => {
    if (!mountedRef.current) return;
    setChatState((prev) => {
      const next: PeekChatState = {
        ...prev,
        ...(patch.messages !== undefined ? { messages: patch.messages } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.images !== undefined ? { images: patch.images } : {}),
        ...(patch.abortController !== undefined
          ? { abortController: patch.abortController }
          : {}),
      };
      chatStateRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const gen = ++generationRef.current;
    const initial = parseSnapshotMessages(blockModel.props.messages);
    historyRef.current = initial;
    setHistoryMessages(initial);
    forkBlockIdRef.current = undefined;
    setForkSession(undefined);
    setChatState(EMPTY_PEEK_STATE);
    chatStateRef.current = EMPTY_PEEK_STATE;

    const { rootWorkspaceId, sessionId } = blockModel.props;
    AIProvider.session
      ?.getSession(rootWorkspaceId, sessionId)
      .then((loaded) => {
        if (mountedRef.current && gen === generationRef.current) {
          setSession(loaded ?? null);
        }
      })
      .catch(console.error);

    queryHistoryMessages(rootWorkspaceId, sessionId)
      .then((remote) => {
        if (!mountedRef.current || gen !== generationRef.current) return;
        setHistoryMessages((prev) =>
          prev.map((msg, idx) => {
            const parsed = StreamObjectSchema.array().safeParse(
              remote[idx]?.streamObjects,
            );
            return {
              ...msg,
              streamObjects: parsed.success ? parsed.data : msg.streamObjects,
              attachments: remote[idx]?.attachments ?? msg.attachments,
              generatedFiles: remote[idx]?.generatedFiles ?? msg.generatedFiles,
            };
          }),
        );
      })
      .catch((error: Error) =>
        console.error("Query history messages failed", error),
      );

    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      abortRetry();
      chatStateRef.current.abortController?.abort();
      clearTimeout(scrollTimerRef.current);
    };
  }, [abortRetry, blockModel]);

  useEffect(() => {
    clearTimeout(scrollTimerRef.current);
    if (chatState.status === "transmitting") {
      throttledScrollToEnd();
    } else if (chatState.messages.length > 0) {
      scrollTimerRef.current = setTimeout(scrollToEnd, 500);
    }
    return () => clearTimeout(scrollTimerRef.current);
  }, [chatState, scrollToEnd, throttledScrollToEnd]);

  const buildBranchMessages = useCallback(
    async (forkSessionId: string) => {
      const { store } = host;
      const userInfo = await AIProvider.userInfo;
      const remote = (await queryHistoryMessages(
        store.workspace.id,
        forkSessionId,
        store.id,
      )) as ChatMessage[];
      const baseHistory = historyRef.current;

      if (!remote.length || remote.length <= baseHistory.length) {
        return constructUserInfoWithMessages(remote, userInfo);
      }

      const mergedBase = baseHistory.map((msg, idx) => ({
        ...msg,
        id: remote[idx]?.id ?? msg.id,
        params: remote[idx]?.params,
        streamObjects: remote[idx]?.streamObjects ?? msg.streamObjects,
        attachments: [],
        generatedFiles: remote[idx]?.generatedFiles ?? [],
      }));
      const followUps = constructUserInfoWithMessages(
        remote.slice(baseHistory.length),
        userInfo,
      );
      return [...mergedBase, ...followUps];
    },
    [host],
  );

  const ensureForkSession = useCallback(async () => {
    if (forkSessionRef.current) return forkSessionRef.current;
    const lastHistory = historyRef.current.at(-1);
    if (!lastHistory) return;

    const gen = generationRef.current;
    const { store } = host;
    const forkedId = await AIProvider.forkChat?.({
      workspaceId: store.workspace.id,
      docId: store.id,
      sessionId: blockModel.props.sessionId,
      latestMessageId: lastHistory.id,
    });
    if (!forkedId) return forkSessionRef.current;

    const loaded = await AIProvider.session?.getSession(
      store.workspace.id,
      forkedId,
    );
    if (!mountedRef.current || gen !== generationRef.current) return;
    const resolved = loaded ?? null;
    forkSessionRef.current = resolved;
    setForkSession(resolved);
    return resolved;
  }, [blockModel.props.sessionId, host]);

  const syncForkChatBlock = useCallback(async () => {
    const forkSessionId = forkSessionRef.current?.sessionId;
    if (!forkSessionId || !chatStateRef.current.messages.length) return;

    const { store } = host;
    const gen = generationRef.current;

    if (!forkBlockIdRef.current) {
      const mode = host.std.get(DocModeProvider).getEditorMode();
      if (mode !== "edgeless") return;
      const surface = getSurfaceBlock(store);
      if (!surface) return;

      const messages = await buildBranchMessages(forkSessionId);
      if (
        !messages.length ||
        !mountedRef.current ||
        gen !== generationRef.current ||
        forkSessionRef.current?.sessionId !== forkSessionId ||
        forkBlockIdRef.current ||
        store.readonly ||
        !store.getBlock(blockModel.id)
      ) {
        return;
      }

      const bound = computeBranchChatBound(blockModel, host.std);
      const crud = host.std.get(EdgelessCRUDIdentifier);
      const createdId = crud.addBlock(
        "myoxus:embed-ai-chat",
        {
          xywh: bound.serialize(),
          messages: JSON.stringify(messages),
          sessionId: forkSessionId,
          rootWorkspaceId: store.workspace.id,
          rootDocId: store.id,
        },
        surface.id,
      );
      if (!createdId) return;

      forkBlockIdRef.current = createdId;
      crud.addElement(CanvasElementType.CONNECTOR, {
        mode: ConnectorMode.Curve,
        controllers: [],
        source: { id: blockModel.id },
        target: { id: createdId },
      });
      host.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
        control: "conversation",
        page: "whiteboard editor",
        module: "canvas",
        segment: "whiteboard",
        type: "chat block",
        category: "branch",
      });
      return;
    }

    const targetBlockId = forkBlockIdRef.current;
    const messages = await buildBranchMessages(forkSessionId);
    const block = store.getBlock(targetBlockId);
    if (
      !messages.length ||
      !mountedRef.current ||
      gen !== generationRef.current ||
      forkBlockIdRef.current !== targetBlockId ||
      forkSessionRef.current?.sessionId !== forkSessionId ||
      store.readonly ||
      !block
    ) {
      return;
    }
    store.updateBlock(block.model, { messages: JSON.stringify(messages) });
  }, [blockModel, buildBranchMessages, host]);

  const handleHistoryCleared = useCallback(async () => {
    const branchId = forkBlockIdRef.current;
    if (branchId) {
      const surface = getSurfaceBlock(host.store);
      const crud = host.std.get(EdgelessCRUDIdentifier);
      const branchModel = host.store.getBlock(branchId)?.model;
      if (branchModel) {
        const connectors = surface?.getConnectors(branchModel.id);
        host.store.transact(() => {
          crud.removeElement(branchId);
          connectors?.forEach((connector) => crud.removeElement(connector.id));
        });
      }
    }
    chatStateRef.current.abortController?.abort();
    forkBlockIdRef.current = undefined;
    updateState(EMPTY_PEEK_STATE);
  }, [host, updateState]);

  const handleRetry = useCallback(() => {
    const forkId = forkSessionRef.current?.sessionId;
    const branchId = forkBlockIdRef.current;
    if (!forkId || !branchId) return;

    const { store } = host;
    void retryTurn({
      workspaceId: store.workspace.id,
      docId: store.id,
      sessionId: forkId,
      ensureSessionId: async () => forkId,
      previousMessages: chatStateRef.current.messages,
      status: chatStateRef.current.status,
      aiModelService,
      reasoningConfig,
      aiToolsConfigService,
      host,
      where: "ai-chat-block",
      control: "chat-send",
      isScopeStillCurrent: () =>
        host.store === store &&
        forkSessionRef.current?.sessionId === forkId &&
        forkBlockIdRef.current === branchId,
      onPatch: (patch) => updateState(patch),
      onCompleted: () => syncForkChatBlock(),
    });
  }, [
    aiModelService,
    aiToolsConfigService,
    host,
    reasoningConfig,
    retryTurn,
    syncForkChatBlock,
    updateState,
  ]);

  const setViewport = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      if (el) scrollToEnd();
    },
    [scrollToEnd],
  );

  if (!historyMessages.length) return null;

  const latestCreatedAt = historyMessages[historyMessages.length - 1].createdAt;
  const { status, error, messages: liveMessages } = chatState;
  const isBusy = status === "transmitting" || status === "loading";

  return (
    <ChatPeekConversation
      viewportRef={setViewport}
      header={
        <AIHistoryClear
          doc={host.store}
          session={forkSession}
          onHistoryCleared={handleHistoryCleared}
          chatContextValue={chatState}
          notificationService={notificationService}
        />
      }
      composer={
        <AIChatComposer
          host={host}
          workspaceId={host.store.workspace.id}
          docId={host.store.id}
          session={forkSession ?? session}
          createSession={ensureForkSession}
          chatContextValue={chatState}
          updateContext={updateState}
          docDisplayConfig={docDisplayConfig}
          searchMenuConfig={searchMenuConfig}
          notificationService={notificationService}
          aiToolsConfigService={aiToolsConfigService}
          onChatSuccess={() => void syncForkChatBlock()}
          trackOptions={PEEK_TRACKING}
          reasoningConfig={reasoningConfig}
          aiModelService={aiModelService}
        />
      }
    >
      <StoredChatMessages
        host={host}
        messages={historyMessages}
        readOnly={host.store.readonly}
        showGeneratedFiles
        docDisplayConfig={docDisplayConfig}
        peekViewService={peekViewService}
      />
      <MyoxusText
        component="time"
        dateTime={latestCreatedAt}
        typographySlot="caption"
        tone="secondary"
        ta="center"
      >
        {i18nTime(latestCreatedAt, {
          relative: { max: [1, "day"], accuracy: "minute", weekday: true },
          absolute: { accuracy: "second" },
        })}
      </MyoxusText>
      {liveMessages.map((message, idx) => {
        const isAssistant = message.role === "assistant";
        const isLastReply = idx === liveMessages.length - 1 && isAssistant;
        if (status === "loading" && isLastReply) {
          return <ChatLoading key={`loading-${idx}`} />;
        }

        const msgState = isLastReply && isBusy ? "generating" : "finished";
        const markdown = message.streamObjects?.length
          ? mergeStreamContent(message.streamObjects)
          : message.content;
        const toolFileIds = collectToolCreatedFileIds(
          message.streamObjects,
          message.id,
          message.generatedFiles,
        );
        const remainingFiles = message.generatedFiles?.filter(
          (file) => !toolFileIds.has(file.id),
        );

        return (
          <Stack key={message.id || `live-${idx}`} gap="xs">
            <StoredChatMessages
              host={host}
              messages={[message]}
              state={msgState}
              readOnly={host.store.readonly}
              docDisplayConfig={docDisplayConfig}
              peekViewService={peekViewService}
            />
            {isLastReply && status === "error" && error
              ? AIChatErrorRenderer(error, host)
              : null}
            {isAssistant && !(isLastReply && isBusy) ? (
              <CopilotResponseActions
                host={host}
                sessionId={forkSession?.sessionId}
                actions={ChatBlockPeekViewActions}
                content={markdown}
                messageId={message.id || undefined}
                generatedFiles={remainingFiles}
                exportable={
                  !host.store.readonly &&
                  !!markdown.trim() &&
                  (message.params?.streamStatus === undefined ||
                    message.params?.streamStatus === "done")
                }
                retry={isLastReply ? handleRetry : undefined}
                notificationService={notificationService}
              />
            ) : null}
          </Stack>
        );
      })}
    </ChatPeekConversation>
  );
}
