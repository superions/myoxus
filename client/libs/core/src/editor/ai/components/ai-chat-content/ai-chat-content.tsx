// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import { Box } from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import { ChatErrorView } from "../../messages/error-view";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import { AIChatComposer } from "../ai-chat-composer/ai-chat-composer";
import type { AIReasoningConfig } from "../ai-chat-input";
import {
  AIChatMessages,
  type AIChatMessagesHandle,
} from "../ai-chat-messages/ai-chat-messages";
import { isChatMessage } from "../ai-chat-messages/type";
import { ArtifactPreviewView } from "../ai-tools/artifact-view";
import { ChatPreviewContext } from "../ai-tools/preview-context";
import { chatI18n } from "../chat-i18n";
import { useChatSession } from "../hooks/use-chat-session";
import { ChatConversationLayout } from "../message-chrome";
import type { ChatContextValue } from "./type";

export interface AIChatContentProps {
  independentMode?: boolean;
  boundedMode?: boolean;
  host?: EditorHost | null;
  pageBridge?: PageAiBridge | null;
  session: CopilotChatHistoryFragment | null | undefined;
  createSession: () => Promise<CopilotChatHistoryFragment | null | undefined>;
  workspaceId: string;
  docId?: string;
  reasoningConfig: AIReasoningConfig;
  searchMenuConfig: SearchMenuConfig;
  docDisplayConfig: DocDisplayConfig;
  notificationService: NotificationService;
  aiDraftService?: AIDraftService;
  aiToolsConfigService: AIToolsConfigService;
  aiModelService: AIModelService;
  peekViewService: PeekViewService;
  onEmbeddingProgressChange?: (
    count: Record<ContextEmbedStatus, number>,
  ) => void;
  onContextChange?: (context: Partial<ChatContextValue>) => void;
  onOpenDoc: (docId: string, sessionId?: string) => void;
}

/**
 * Top-level chat conversation view shared by the document sidebar and the
 * standalone `/chat` route.
 */
export function AIChatContent(props: AIChatContentProps) {
  const {
    independentMode,
    boundedMode = false,
    host,
    pageBridge,
    session,
    createSession,
    workspaceId,
    docId,
    reasoningConfig,
    searchMenuConfig,
    docDisplayConfig,
    notificationService,
    aiDraftService,
    aiToolsConfigService,
    aiModelService,
    peekViewService,
    onEmbeddingProgressChange,
    onContextChange,
    onOpenDoc,
  } = props;

  const {
    chatContext,
    updateContext,
    isHistoryLoading,
    historyLoadFailed,
    reloadHistory,
    previewState,
    previewController,
    closePreviewPanel,
  } = useChatSession({
    host,
    workspaceId,
    docId,
    session,
    aiDraftService,
    onContextChange,
  });

  const [canScrollToLatest, setCanScrollToLatest] = useState(false);
  const messagesRef = useRef<AIChatMessagesHandle | null>(null);
  const savedScrollTopRef = useRef<number | undefined>(undefined);
  const previousHostRef = useRef(host);

  useEffect(() => {
    if (
      previousHostRef.current !== host &&
      session?.pinned &&
      savedScrollTopRef.current !== undefined
    ) {
      messagesRef.current?.scrollToPos(savedScrollTopRef.current);
    }
    previousHostRef.current = host;
  }, [host, session?.pinned]);

  const messages = useMemo(
    () => chatContext.messages.filter(isChatMessage),
    [chatContext.messages],
  );

  const scrollToLatest = useCallback(() => {
    messagesRef.current?.scrollToEnd();
  }, []);

  const recordScrollTop = useCallback((top: number) => {
    savedScrollTopRef.current = top;
  }, []);

  const previewNode =
    previewState.open && previewState.data ? (
      <ArtifactPreviewView
        title={previewState.data.title}
        icon={previewState.data.icon}
        controls={previewState.data.controls}
        close={closePreviewPanel}
      >
        {previewState.data.content}
      </ArtifactPreviewView>
    ) : null;

  return (
    <ChatPreviewContext.Provider value={previewController}>
      <Box
        display="flex"
        h={independentMode ? "100%" : undefined}
        mih={boundedMode ? 0 : undefined}
        w="100%"
        style={{
          flexDirection: "column",
          ...(boundedMode ? { flex: "1 1 auto" } : {}),
        }}
        data-myoxus-ui-role="ai-chat-content"
      >
        <ChatConversationLayout
          independent={!!independentMode}
          open={previewState.open}
          preview={previewNode}
        >
          {historyLoadFailed ? (
            <ChatErrorView
              text={chatI18n()["com.myoxus.ai.chat-panel.history-error"]()}
              action={chatI18n()["Retry"]()}
              onAction={() => void reloadHistory()}
            />
          ) : null}
          <AIChatMessages
            ref={messagesRef}
            aiModelService={aiModelService}
            onScrollAvailabilityChange={setCanScrollToLatest}
            onScrollEnd={recordScrollTop}
            host={host}
            pageBridge={pageBridge}
            workspaceId={workspaceId}
            docId={docId}
            session={session}
            createSession={createSession}
            chatContextValue={chatContext}
            updateContext={updateContext}
            isHistoryLoading={isHistoryLoading}
            notificationService={notificationService}
            aiToolsConfigService={aiToolsConfigService}
            reasoningConfig={reasoningConfig}
            independentMode={independentMode}
            boundedMode={boundedMode}
            messages={messages}
            docDisplayService={docDisplayConfig}
            peekViewService={peekViewService}
            onOpenDoc={onOpenDoc}
          />
          <AIChatComposer
            onScrollToLatest={canScrollToLatest ? scrollToLatest : undefined}
            independentMode={independentMode}
            host={host}
            workspaceId={workspaceId}
            docId={docId}
            session={session}
            createSession={createSession}
            chatContextValue={chatContext}
            updateContext={updateContext}
            onEmbeddingProgressChange={onEmbeddingProgressChange}
            reasoningConfig={reasoningConfig}
            docDisplayConfig={docDisplayConfig}
            searchMenuConfig={searchMenuConfig}
            notificationService={notificationService}
            aiDraftService={aiDraftService}
            aiToolsConfigService={aiToolsConfigService}
            aiModelService={aiModelService}
            trackOptions={{ where: "chat-panel", control: "chat-send" }}
          />
        </ChatConversationLayout>
      </Box>
    </ChatPreviewContext.Provider>
  );
}
