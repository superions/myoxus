// SPDX-License-Identifier: MIT

import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { NewPageIcon as NativeNewPageIcon } from "@myoxus/icons/react";
import { IconButton } from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/editor/shared/services";
import type { EditorHost } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { throttle } from "lodash-es";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AIProvider } from "../../provider";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import { AIChatComposer } from "../ai-chat-composer/ai-chat-composer";
import type { ChatContextValue } from "../ai-chat-content/type";
import type { AIReasoningConfig } from "../ai-chat-input";
import {
  AIChatMessages,
  type AIChatMessagesHandle,
} from "../ai-chat-messages/ai-chat-messages";
import { type ChatMessage, isChatMessage } from "../ai-chat-messages/type";
import { AIHistoryClear } from "../ai-history-clear/ai-history-clear";
import { PlaygroundConversation } from "./view";

const DEFAULT_CHAT_CONTEXT_VALUE: ChatContextValue = {
  quote: "",
  images: [],
  abortController: null,
  messages: [],
  status: "idle",
  error: null,
  markdown: "",
  snapshot: null,
  attachments: [],
  combinedElementsMarkdown: null,
  docs: [],
  html: null,
};

export interface PlaygroundChatProps {
  host: EditorHost;
  doc: Store;
  session: CopilotChatHistoryFragment | null | undefined;
  peekViewService: PeekViewService;
  onOpenDoc: (docId: string, sessionId?: string) => void;
  reasoningConfig: AIReasoningConfig;
  searchMenuConfig: SearchMenuConfig;
  docDisplayConfig: DocDisplayConfig;
  notificationService: NotificationService;
  aiToolsConfigService: AIToolsConfigService;
  aiModelService: AIModelService;
  addChat: () => Promise<void>;
  onHistoryCleared: () => Promise<void>;
  syncedDraft: string;
  onSyncedDraftChange: (value: string) => void;
  onRegisterSend: (send: () => void) => () => void;
  onBroadcastSend: () => void;
}

export function PlaygroundChat({
  host,
  doc,
  session,
  peekViewService,
  onOpenDoc,
  reasoningConfig,
  searchMenuConfig,
  docDisplayConfig,
  notificationService,
  aiToolsConfigService,
  aiModelService,
  addChat,
  onHistoryCleared,
  syncedDraft,
  onSyncedDraftChange,
  onRegisterSend,
  onBroadcastSend,
}: PlaygroundChatProps) {
  const t = useI18n();
  const [isLoading, setIsLoading] = useState(false);
  const [chatContextValue, setChatContextValue] = useState<ChatContextValue>(
    DEFAULT_CHAT_CONTEXT_VALUE,
  );
  const [embeddingProgress, setEmbeddingProgress] = useState<[number, number]>([
    0, 0,
  ]);

  const chatMessagesRef = useRef<AIChatMessagesHandle | null>(null);
  const updateHistoryCounterRef = useRef(0);

  const scrollToEnd = useCallback(() => {
    chatMessagesRef.current?.scrollToEnd();
  }, []);

  const throttledScrollToEnd = useMemo(
    () => throttle(scrollToEnd, 600),
    [scrollToEnd],
  );

  useEffect(() => {
    return () => throttledScrollToEnd.cancel();
  }, [throttledScrollToEnd]);

  useEffect(() => {
    let active = true;
    const init = async () => {
      const userId = (await AIProvider.userInfo)?.id;
      if (!active || !userId || !AIProvider.histories) return;
      setIsLoading(true);
      const currentRequest = ++updateHistoryCounterRef.current;
      const sessionId = session?.sessionId;
      const histories = sessionId
        ? await AIProvider.histories.chats(doc.workspace.id, sessionId, doc.id)
        : [];
      if (!active || currentRequest !== updateHistoryCounterRef.current) return;
      const messages = ((histories?.[0]?.messages || []) as ChatMessage[]).sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      setChatContextValue((prev) => ({ ...prev, messages }));
      setIsLoading(false);
      scrollToEnd();
    };
    void init().catch(console.error);
    return () => {
      active = false;
    };
  }, [doc, scrollToEnd, session?.sessionId]);

  const updateContext = useCallback(
    (context: Partial<ChatContextValue>) => {
      setChatContextValue((prev) => {
        const next = { ...prev, ...context };
        if (
          next.status === "loading" ||
          next.status === "error" ||
          next.status === "success"
        ) {
          setTimeout(scrollToEnd, 500);
        }
        if (next.status === "transmitting") {
          throttledScrollToEnd();
        }
        return next;
      });
    },
    [scrollToEnd, throttledScrollToEnd],
  );

  const createSession = useCallback(async () => session, [session]);

  const onEmbeddingProgressChange = useCallback(
    (count: Record<ContextEmbedStatus, number>) => {
      const total = count.finished + count.processing + count.failed;
      setEmbeddingProgress([count.finished, total]);
    },
    [],
  );

  const messages = useMemo(
    () => chatContextValue.messages.filter(isChatMessage),
    [chatContextValue.messages],
  );

  const newChatLabel = t["com.myoxus.ai.chat-panel.new-chat"]();
  const [done, total] = embeddingProgress;

  return (
    <PlaygroundConversation
      done={done}
      total={total}
      actions={
        <>
          <IconButton
            icon={<NativeNewPageIcon />}
            tooltip={newChatLabel}
            aria-label={newChatLabel}
            onClick={() => void addChat()}
          />
          <AIHistoryClear
            doc={doc}
            session={session}
            notificationService={notificationService}
            onHistoryCleared={onHistoryCleared}
            chatContextValue={chatContextValue}
          />
        </>
      }
      composer={
        <AIChatComposer
          host={host}
          workspaceId={doc.workspace.id}
          docId={doc.id}
          session={session}
          createSession={createSession}
          chatContextValue={chatContextValue}
          updateContext={updateContext}
          onEmbeddingProgressChange={onEmbeddingProgressChange}
          reasoningConfig={reasoningConfig}
          docDisplayConfig={docDisplayConfig}
          searchMenuConfig={searchMenuConfig}
          notificationService={notificationService}
          aiToolsConfigService={aiToolsConfigService}
          aiModelService={aiModelService}
          syncedDraft={syncedDraft}
          onSyncedDraftChange={onSyncedDraftChange}
          onRegisterSend={onRegisterSend}
          onBroadcastSend={onBroadcastSend}
        />
      }
    >
      <AIChatMessages
        ref={chatMessagesRef}
        aiModelService={aiModelService}
        docDisplayService={docDisplayConfig}
        peekViewService={peekViewService}
        onOpenDoc={onOpenDoc}
        host={host}
        workspaceId={doc.workspace.id}
        docId={doc.id}
        isHistoryLoading={isLoading}
        chatContextValue={chatContextValue}
        session={session}
        createSession={createSession}
        updateContext={updateContext}
        notificationService={notificationService}
        aiToolsConfigService={aiToolsConfigService}
        reasoningConfig={reasoningConfig}
        messages={messages}
      />
    </PlaygroundConversation>
  );
}
