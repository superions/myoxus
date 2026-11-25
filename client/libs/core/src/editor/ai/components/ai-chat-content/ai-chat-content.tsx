// SPDX-License-Identifier: MIT

import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIDraftState } from "@myoxus/core/modules/ai-button/services/ai-draft";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import { Box } from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/editor/std";
import { pick } from "lodash-es";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import { ChatErrorView } from "../../messages/error-view";
import { type AIChatParams, AIProvider } from "../../provider/ai-provider";
import { extractSelectedContent } from "../../utils/extract";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import { AIChatComposer } from "../ai-chat-composer/ai-chat-composer";
import type { AIReasoningConfig } from "../ai-chat-input";
import {
  AIChatMessages,
  type AIChatMessagesHandle,
} from "../ai-chat-messages/ai-chat-messages";
import { type ChatMessage, isChatMessage } from "../ai-chat-messages/type";
import { ArtifactPreviewView } from "../ai-tools/artifact-view";
import {
  type ArtifactPreviewPayload,
  ChatPreviewContext,
  type ChatPreviewController,
} from "../ai-tools/preview-context";
import { chatI18n } from "../chat-i18n";
import { ChatConversationLayout } from "../message-chrome";
import type { ChatContextValue } from "./type";

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

export function AIChatContent({
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
}: AIChatContentProps) {
  const [chatContextValue, setChatContextValue] = useState<ChatContextValue>(
    DEFAULT_CHAT_CONTEXT_VALUE,
  );
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [canScrollToLatest, setCanScrollToLatest] = useState(false);
  const [previewState, setPreviewState] = useState<{
    open: boolean;
    ownerId: string | null;
    data: ArtifactPreviewPayload | null;
  }>({ open: false, ownerId: null, data: null });

  const mountedRef = useRef(true);
  const chatMessagesRef = useRef<AIChatMessagesHandle | null>(null);
  const chatContextRef = useRef(chatContextValue);
  chatContextRef.current = chatContextValue;
  const previewStateRef = useRef(previewState);
  previewStateRef.current = previewState;

  const updateHistoryCounterRef = useRef(0);
  const historyIdentityRef = useRef<string | undefined>(undefined);
  const draftRestoreRevisionRef = useRef(0);
  const lastScrollTopRef = useRef<number | undefined>(undefined);
  const prevHostRef = useRef(host);

  const currentHistoryIdentity = JSON.stringify([
    workspaceId,
    docId ?? null,
    session?.sessionId ?? null,
  ]);
  const identityRef = useRef(currentHistoryIdentity);
  identityRef.current = currentHistoryIdentity;

  const latestRef = useRef({
    host,
    workspaceId,
    docId,
    session,
    aiDraftService,
    onContextChange,
  });
  latestRef.current = {
    host,
    workspaceId,
    docId,
    session,
    aiDraftService,
    onContextChange,
  };

  const updateContext = useCallback((context: Partial<ChatContextValue>) => {
    if (["quote", "images", "markdown"].some((key) => key in context)) {
      draftRestoreRevisionRef.current++;
    }
    const current = chatContextRef.current;
    if (
      (context.status === "loading" || context.status === "transmitting") &&
      current.status !== "loading" &&
      current.status !== "transmitting"
    ) {
      updateHistoryCounterRef.current++;
      setIsHistoryLoading(false);
    }
    const next = { ...current, ...context };
    chatContextRef.current = next;
    setChatContextValue(next);
    latestRef.current.onContextChange?.(context);

    const draftService = latestRef.current.aiDraftService;
    if (draftService) {
      const draft: Partial<AIDraftState> = pick(context, [
        "quote",
        "images",
        "markdown",
      ]);
      if (Object.keys(draft).length) {
        draftService.setDraft(draft).catch(console.error);
      }
    }
  }, []);

  const initChatContent = useCallback(async () => {
    const request = ++updateHistoryCounterRef.current;
    const identity = identityRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      request === updateHistoryCounterRef.current &&
      identity === identityRef.current;

    setIsHistoryLoading(true);
    setHistoryLoadFailed(false);
    try {
      if (!AIProvider.histories) return;
      const sessionId = latestRef.current.session?.sessionId;
      const histories = sessionId
        ? await AIProvider.histories.chats(
            latestRef.current.workspaceId,
            sessionId,
          )
        : [];
      const messages = ((histories?.[0]?.messages || []) as ChatMessage[]).sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      if (isCurrent()) updateContext({ messages });
    } catch {
      if (isCurrent()) setHistoryLoadFailed(true);
    } finally {
      if (isCurrent()) setIsHistoryLoading(false);
    }
  }, [updateContext]);

  // Restore scroll position when host switches while pinned.
  useEffect(() => {
    if (
      prevHostRef.current !== host &&
      session?.pinned &&
      lastScrollTopRef.current !== undefined
    ) {
      chatMessagesRef.current?.scrollToPos(lastScrollTopRef.current);
    }
    prevHostRef.current = host;
  }, [host, session?.pinned]);

  // Track history identity transitions.
  useEffect(() => {
    if (currentHistoryIdentity === historyIdentityRef.current) return;
    const previous = historyIdentityRef.current
      ? (JSON.parse(historyIdentityRef.current) as [
          string | null,
          string | null,
          string | null,
        ])
      : undefined;
    const currentCtx = chatContextRef.current;
    if (
      previous &&
      (previous[0] !== workspaceId ||
        previous[1] !== (docId ?? null) ||
        (previous[2] !== null && previous[2] !== (session?.sessionId ?? null)))
    ) {
      currentCtx.abortController?.abort();
      updateContext({
        abortController: null,
        status: "idle",
        retrievalAvailable: undefined,
      });
    }
    historyIdentityRef.current = currentHistoryIdentity;
    const latestCtx = chatContextRef.current;
    // Assigning the newly created session during send is not a history switch:
    // the active request already owns its user turn and pending assistant.
    if (latestCtx.status === "loading" || latestCtx.status === "transmitting") {
      updateHistoryCounterRef.current += 1;
      setIsHistoryLoading(false);
      return;
    }
    if (session?.messages?.length && !latestCtx.messages.length) {
      const next = {
        ...latestCtx,
        messages: session.messages as ChatMessage[],
      };
      chatContextRef.current = next;
      setChatContextValue(next);
    }
    void initChatContent();
  }, [
    currentHistoryIdentity,
    docId,
    initChatContent,
    session,
    updateContext,
    workspaceId,
  ]);

  // Subscriptions & draft restoration.
  useEffect(() => {
    mountedRef.current = true;
    const sessionReadySub = AIProvider.slots.sessionReady.subscribe((ready) => {
      const status = chatContextRef.current.status;
      if (
        ready &&
        historyIdentityRef.current &&
        status !== "loading" &&
        status !== "transmitting"
      ) {
        void initChatContent();
      }
    });

    if (aiDraftService) {
      const revision = draftRestoreRevisionRef.current;
      aiDraftService
        .getDraft()
        .then((draft) => {
          if (
            !mountedRef.current ||
            revision !== draftRestoreRevisionRef.current
          )
            return;
          setChatContextValue((prev) => {
            const next = {
              ...prev,
              quote: draft.quote,
              markdown: draft.markdown,
              images: draft.images,
            };
            chatContextRef.current = next;
            return next;
          });
        })
        .catch(console.error);
    }

    const openWithChatSub = AIProvider.slots.requestOpenWithChat.subscribe(
      (params: AIChatParams | null) => {
        if (!params) return;
        const matchesTarget = params.host
          ? latestRef.current.host === params.host
          : !latestRef.current.host &&
            (!params.docId || latestRef.current.docId === params.docId);
        if (matchesTarget) {
          if (params.context) {
            updateContext(params.context);
          } else if (params.host) {
            extractSelectedContent(params.host)
              .then((context) => {
                if (!context) return;
                updateContext(context);
              })
              .catch(console.error);
          }
        }
        AIProvider.slots.requestOpenWithChat.next(null);
      },
    );

    return () => {
      mountedRef.current = false;
      draftRestoreRevisionRef.current++;
      updateHistoryCounterRef.current += 1;
      chatContextRef.current.abortController?.abort();
      sessionReadySub.unsubscribe();
      openWithChatSub.unsubscribe();
    };
  }, [aiDraftService, initChatContent, updateContext]);

  const previewController = useMemo<ChatPreviewController>(
    () => ({
      openPreview: (ownerId, data) => {
        setPreviewState({ open: true, ownerId, data });
        AIProvider.slots.previewPanelOpenChange.next(true);
      },
      closePreview: (ownerId) => {
        setPreviewState((prev) => {
          if (prev.ownerId !== ownerId) return prev;
          AIProvider.slots.previewPanelOpenChange.next(false);
          return { open: false, ownerId: null, data: null };
        });
      },
      isOwnerOpen: (ownerId) =>
        previewStateRef.current.open &&
        previewStateRef.current.ownerId === ownerId,
    }),
    [],
  );

  const previewNode: ReactNode =
    previewState.open && previewState.data ? (
      <ArtifactPreviewView
        title={previewState.data.title}
        icon={previewState.data.icon}
        controls={previewState.data.controls}
        close={() => {
          setPreviewState({ open: false, ownerId: null, data: null });
          AIProvider.slots.previewPanelOpenChange.next(false);
        }}
      >
        {previewState.data.content}
      </ArtifactPreviewView>
    ) : null;

  const messages = useMemo(
    () => chatContextValue.messages.filter(isChatMessage),
    [chatContextValue.messages],
  );

  const scrollToLatest = useCallback(() => {
    chatMessagesRef.current?.scrollToEnd();
  }, []);

  const handleScrollEnd = useCallback((scrollTop: number) => {
    lastScrollTopRef.current = scrollTop;
  }, []);

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
              onAction={() => void initChatContent()}
            />
          ) : null}
          <AIChatMessages
            ref={chatMessagesRef}
            aiModelService={aiModelService}
            onScrollAvailabilityChange={setCanScrollToLatest}
            onScrollEnd={handleScrollEnd}
            host={host}
            pageBridge={pageBridge}
            workspaceId={workspaceId}
            docId={docId}
            session={session}
            createSession={createSession}
            chatContextValue={chatContextValue}
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
            chatContextValue={chatContextValue}
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
