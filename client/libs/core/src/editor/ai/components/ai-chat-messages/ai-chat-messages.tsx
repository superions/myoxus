// SPDX-License-Identifier: MIT

import type { AIToolsConfigService } from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { Scrollable, useDebouncedCallback } from "@myoxus/ui-facade";
import {
  DocModeProvider,
  type NotificationService,
} from "@virgultum/editor/shared/services";
import type { EditorHost } from "@virgultum/editor/std";
import { nanoid } from "nanoid";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import { AssistantReply } from "../../chat-panel/message/assistant";
import { type AIError, AIProvider, UnauthorizedError } from "../../provider";
import { resolveRetryTarget } from "../../utils/chat-turn";
import { mergeStreamObjects } from "../../utils/stream-objects";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { ChatContextValue } from "../ai-chat-content/type";
import type { AIReasoningConfig } from "../ai-chat-input";
import { ChatConversation, ChatUserMessage } from "../message-chrome";
import {
  type ChatMessage,
  type HistoryMessage,
  isChatMessage,
  StreamObjectSchema,
} from "./type";

const EDITOR_PREVIEW_SCROLL_THRESHOLD_PX = 180;

export interface AIChatMessagesHandle {
  scrollToEnd: () => void;
  scrollToPos: (top: number) => void;
  getScrollTop: () => number;
}

export interface AIChatMessagesProps {
  aiModelService?: AIModelService;
  onScrollAvailabilityChange?: (available: boolean) => void;
  onScrollEnd?: (scrollTop: number) => void;
  independentMode?: boolean;
  boundedMode?: boolean;
  messages: HistoryMessage[];
  host?: EditorHost | null;
  pageBridge?: PageAiBridge | null;
  workspaceId: string;
  docId?: string;
  isHistoryLoading: boolean;
  chatContextValue: ChatContextValue;
  session: CopilotChatHistoryFragment | null | undefined;
  createSession: () => Promise<CopilotChatHistoryFragment | null | undefined>;
  updateContext: (context: Partial<ChatContextValue>) => void;
  notificationService: NotificationService;
  reasoningConfig: AIReasoningConfig;
  docDisplayService: DocDisplayConfig;
  aiToolsConfigService: AIToolsConfigService;
  peekViewService: PeekViewService;
  onOpenDoc: (docId: string, sessionId?: string) => void;
  testId?: string;
}

export const AIChatMessages = forwardRef<
  AIChatMessagesHandle,
  AIChatMessagesProps
>(function AIChatMessages(
  {
    aiModelService,
    onScrollAvailabilityChange,
    onScrollEnd,
    independentMode,
    boundedMode,
    messages,
    host,
    pageBridge,
    workspaceId,
    docId,
    isHistoryLoading,
    chatContextValue,
    session,
    createSession,
    updateContext,
    notificationService,
    reasoningConfig,
    docDisplayService,
    aiToolsConfigService,
    peekViewService,
    onOpenDoc,
    testId = "chat-panel-messages",
  },
  ref,
) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const canScrollDownRef = useRef(false);
  const retryControllerRef = useRef<AbortController | null>(null);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [userName, setUserName] = useState("");
  const [, setHostTick] = useState(0);

  const latestRef = useRef({
    aiModelService,
    onScrollAvailabilityChange,
    onScrollEnd,
    workspaceId,
    docId,
    chatContextValue,
    session,
    createSession,
    updateContext,
    reasoningConfig,
    aiToolsConfigService,
  });
  latestRef.current = {
    aiModelService,
    onScrollAvailabilityChange,
    onScrollEnd,
    workspaceId,
    docId,
    chatContextValue,
    session,
    createSession,
    updateContext,
    reasoningConfig,
    aiToolsConfigService,
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: () => {
        requestAnimationFrame(() => {
          const el = scrollerRef.current;
          if (!el) return;
          el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        });
      },
      scrollToPos: (top: number) => {
        requestAnimationFrame(() => {
          scrollerRef.current?.scrollTo({ top });
        });
      },
      getScrollTop: () => scrollerRef.current?.scrollTop ?? 0,
    }),
    [],
  );

  const checkScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const available =
      el.scrollHeight - el.scrollTop - el.clientHeight >
      EDITOR_PREVIEW_SCROLL_THRESHOLD_PX;
    if (canScrollDownRef.current !== available) {
      canScrollDownRef.current = available;
      latestRef.current.onScrollAvailabilityChange?.(available);
    }
  }, []);

  const debouncedCheckScroll = useDebouncedCallback(checkScroll, 100);
  const debouncedScrollEnd = useDebouncedCallback(() => {
    const el = scrollerRef.current;
    if (el) latestRef.current.onScrollEnd?.(el.scrollTop);
  }, 150);

  useEffect(() => {
    return () => {
      debouncedCheckScroll.cancel();
      debouncedScrollEnd.cancel();
    };
  }, [debouncedCheckScroll, debouncedScrollEnd]);

  useEffect(() => {
    canScrollDownRef.current = false;
    onScrollAvailabilityChange?.(false);
  }, [isHistoryLoading, onScrollAvailabilityChange]);

  useEffect(() => {
    if (chatContextValue.status === "transmitting") {
      checkScroll();
    }
  }, [chatContextValue, checkScroll]);

  useEffect(() => {
    mountedRef.current = true;
    Promise.resolve(AIProvider.userInfo)
      .then((res) => {
        if (!mountedRef.current) return;
        setAvatarUrl(res?.avatarUrl ?? "");
        setUserName(res?.name ?? "");
      })
      .catch(console.error);

    const sub = AIProvider.slots.userInfo.subscribe((userInfo) => {
      setAvatarUrl(userInfo?.avatarUrl ?? "");
      setUserName(userInfo?.name ?? "");
      const { status, error } = latestRef.current.chatContextValue;
      if (
        status === "error" &&
        error instanceof UnauthorizedError &&
        userInfo
      ) {
        latestRef.current.updateContext({ status: "idle", error: null });
      }
    });

    return () => {
      mountedRef.current = false;
      retryControllerRef.current?.abort();
      retryControllerRef.current = null;
      sub.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!host) return;
    const unsubs: Array<{ unsubscribe: () => void } | undefined> = [];
    const selection$ = host.selection.slots.changed;
    if (selection$) {
      unsubs.push(selection$.subscribe(() => setHostTick((v) => v + 1)));
    }
    const docModeService = host.std.get(DocModeProvider);
    if (docModeService && docId) {
      unsubs.push(
        docModeService.onPrimaryModeChange(
          () => setHostTick((v) => v + 1),
          docId,
        ),
      );
    }
    return () => unsubs.forEach((u) => u?.unsubscribe());
  }, [host, docId]);

  const handleScroll = useCallback(() => {
    debouncedCheckScroll();
    debouncedScrollEnd();
  }, [debouncedCheckScroll, debouncedScrollEnd]);

  const retry = useCallback(async () => {
    const cur = latestRef.current;
    if (
      (retryControllerRef.current &&
        !retryControllerRef.current.signal.aborted) ||
      ["loading", "transmitting"].includes(cur.chatContextValue.status) ||
      !AIProvider.actions.chat
    )
      return;
    const previous = cur.chatContextValue.messages;
    if (
      !cur.aiModelService?.supportsVision &&
      previous.some(
        (message) =>
          isChatMessage(message) &&
          message.role === "user" &&
          !!message.attachments?.length,
      )
    )
      return;
    const last = previous.at(-1);
    if (!last || !isChatMessage(last) || last.role !== "assistant") return;

    const abortController = new AbortController();
    const requestId = nanoid();
    const modelId = cur.aiModelService?.effectiveModelId;
    const reasoning = cur.aiModelService?.reasoningAvailable
      ? !!cur.reasoningConfig.enabled.value
      : undefined;
    const toolsConfig = cur.aiToolsConfigService.config.value;
    let sawOutput = false;
    retryControllerRef.current = abortController;

    const reqWorkspaceId = cur.workspaceId;
    const reqDocId = cur.docId;
    const initialSessionId = cur.session?.sessionId;
    let ownedSessionId = initialSessionId;

    const isCurrent = () =>
      mountedRef.current &&
      !abortController.signal.aborted &&
      retryControllerRef.current === abortController &&
      latestRef.current.workspaceId === reqWorkspaceId &&
      latestRef.current.docId === reqDocId &&
      (latestRef.current.session?.sessionId === initialSessionId ||
        latestRef.current.session?.sessionId === ownedSessionId) &&
      (!latestRef.current.chatContextValue.abortController ||
        latestRef.current.chatContextValue.abortController === abortController);

    cur.updateContext({
      status: "loading",
      error: null,
      abortController,
      retrievalAvailable: undefined,
    });

    try {
      const sessionId = (await cur.createSession())?.sessionId;
      ownedSessionId = sessionId;
      if (!isCurrent() || abortController.signal.aborted) return;
      if (!sessionId) throw new Error("Conversation creation unavailable");
      if (!AIProvider.histories)
        throw new Error("The original user turn is unavailable");
      const history = await AIProvider.histories.chats(
        reqWorkspaceId,
        sessionId,
      );
      if (!isCurrent()) return;
      const stored = (history?.[0]?.messages ?? []) as ChatMessage[];
      const { user, response, expectedStreamId } = resolveRetryTarget(
        previous,
        stored,
      );
      let requestMessages: HistoryMessage[] = [
        ...previous.slice(0, -1),
        {
          ...last,
          content: "",
          streamObjects: [],
          createdAt: new Date().toISOString(),
          id: response?.id ?? "",
          params: { requestId },
        },
      ];
      latestRef.current.updateContext({ messages: requestMessages });

      const stream = await AIProvider.actions.chat({
        sessionId,
        retry: true,
        requestId,
        messageId: user.id,
        responseId: response?.id,
        expectedStreamId,
        docId: reqDocId,
        workspaceId: reqWorkspaceId,
        stream: true,
        signal: abortController.signal,
        where: "chat-panel",
        control: "chat-send",
        isRootSession: true,
        modelId,
        reasoning,
        toolsConfig,
        onRetrievalStatus: (available) => {
          if (isCurrent())
            latestRef.current.updateContext({ retrievalAvailable: available });
        },
      });

      for await (const text of stream) {
        if (!isCurrent() || abortController.signal.aborted) break;
        const nextMessages = requestMessages.slice(0);
        const tail = nextMessages.at(-1);
        if (tail && isChatMessage(tail)) {
          sawOutput = true;
          try {
            const parsed = StreamObjectSchema.parse(JSON.parse(text));
            const streamObjects = mergeStreamObjects([
              ...(tail.streamObjects ?? []),
              parsed,
            ]);
            nextMessages[nextMessages.length - 1] = { ...tail, streamObjects };
          } catch {
            nextMessages[nextMessages.length - 1] = {
              ...tail,
              content: tail.content + text,
            };
          }
          requestMessages = nextMessages;
          latestRef.current.updateContext({
            messages: nextMessages,
            status: "transmitting",
          });
        }
      }

      if (isCurrent() && !abortController.signal.aborted) {
        const finalHistory = await AIProvider.histories.chats(
          reqWorkspaceId,
          sessionId,
        );
        if (!isCurrent()) return;
        const final = (finalHistory?.[0]?.messages ?? []) as ChatMessage[];
        const current = final.find(
          (message) =>
            message.role === "assistant" &&
            message.params?.requestId === requestId &&
            message.params?.responseTo === user.id,
        );
        if (!current)
          throw new Error(
            "The regenerated response identity could not be reconciled",
          );
        latestRef.current.updateContext({
          status: "success",
          messages: [
            ...requestMessages.slice(0, -1),
            {
              ...requestMessages.at(-1)!,
              id: current.id,
              params: current.params,
              generatedFiles: current.generatedFiles,
            },
          ],
        });
      }
    } catch (error) {
      if (isCurrent()) {
        latestRef.current.updateContext(
          abortController.signal.aborted
            ? { status: "idle" }
            : {
                status: "error",
                error: error as AIError,
                ...(!sawOutput ? { messages: previous } : {}),
              },
        );
      }
    } finally {
      if (
        isCurrent() &&
        latestRef.current.chatContextValue.abortController === abortController
      ) {
        latestRef.current.updateContext({
          abortController: null,
          ...(abortController.signal.aborted ? { status: "idle" } : {}),
        });
      }
      if (retryControllerRef.current === abortController) {
        retryControllerRef.current = null;
      }
    }
  }, []);

  const empty = messages.length === 0;
  const { status, error } = chatContextValue;

  const containerStyle: CSSProperties = boundedMode
    ? {
        contain: "size",
        flex: "1 1 auto",
        minHeight: "8lh",
        overscrollBehaviorY: "contain",
      }
    : independentMode
      ? empty
        ? { flex: "0 0 auto" }
        : { flex: 1, minHeight: 0 }
      : { flex: 1, minHeight: 0 };

  return (
    <Scrollable.Viewport
      ref={scrollerRef}
      fill={!boundedMode && (!independentMode || !empty)}
      autosize={Boolean(independentMode && empty)}
      scrollbars="y"
      data-testid={testId}
      data-empty={empty ? "" : undefined}
      style={containerStyle}
      onScroll={handleScroll}
    >
      <ChatConversation loading={isHistoryLoading} empty={empty}>
        {messages.map((item, index) => {
          const isLast = index === messages.length - 1;
          if (!isChatMessage(item)) return null;
          const requestKey =
            typeof item.params?.requestId === "string"
              ? item.params.requestId
              : typeof item.params?.inputRequestId === "string"
                ? item.params.inputRequestId
                : undefined;
          const messageKey = requestKey
            ? `${item.role}:${requestKey}`
            : item.id || `${item.role}:${item.createdAt}:${index}`;
          if (item.role === "user") {
            return (
              <ChatUserMessage
                key={messageKey}
                name={userName}
                avatarUrl={avatarUrl}
                text={item.content}
                images={item.attachments}
              />
            );
          }
          if (item.role !== "assistant") return null;
          return (
            <AssistantReply
              key={messageKey}
              item={item}
              status={isLast ? status : "idle"}
              error={isLast ? error : null}
              retry={isLast ? () => void retry() : undefined}
              sessionId={session?.sessionId}
              host={host}
              pageBridge={pageBridge}
              notificationService={notificationService}
              independentMode={independentMode}
              docDisplayService={docDisplayService}
              peekViewService={peekViewService}
              onOpenDoc={onOpenDoc}
            />
          );
        })}
      </ChatConversation>
    </Scrollable.Viewport>
  );
});
