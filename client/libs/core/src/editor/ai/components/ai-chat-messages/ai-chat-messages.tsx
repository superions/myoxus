// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
import {
  type CSSProperties,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import { AssistantReply } from "../../chat-panel/message/assistant";
import { AIProvider, UnauthorizedError } from "../../provider";
import type { DocDisplayConfig } from "../ai-chat-chips";
import type { ChatContextValue } from "../ai-chat-content/type";
import type { AIReasoningConfig } from "../ai-chat-input";
import { useChatStream } from "../hooks/use-chat-stream";
import { ChatConversation, ChatUserMessage } from "../message-chrome";
import { type HistoryMessage, isChatMessage } from "./type";

const SCROLL_TO_LATEST_THRESHOLD_PX = 180;

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

function stableMessageKey(item: HistoryMessage, index: number): string {
  const reqId =
    typeof item.params?.requestId === "string"
      ? item.params.requestId
      : typeof item.params?.inputRequestId === "string"
        ? item.params.inputRequestId
        : undefined;
  if (reqId) return `${item.role}:${reqId}`;
  return item.id || `${item.role}:${item.createdAt}:${index}`;
}

/**
 * Scrollable conversation timeline backed by Mantine `Scrollable.Viewport`,
 * stable message keys, debounced scroll tracking, and shared `useChatStream`
 * retry handling.
 */
export const AIChatMessages = forwardRef<
  AIChatMessagesHandle,
  AIChatMessagesProps
>(function AIChatMessages(props, ref) {
  const {
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
  } = props;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canScrollDownRef = useRef(false);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [userName, setUserName] = useState("");
  const [, bumpHostRevision] = useState(0);

  const { retryTurn } = useChatStream();

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
          const el = viewportRef.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        });
      },
      scrollToPos: (top: number) => {
        requestAnimationFrame(() => {
          viewportRef.current?.scrollTo({ top });
        });
      },
      getScrollTop: () => viewportRef.current?.scrollTop ?? 0,
    }),
    [],
  );

  const checkScrollAvailability = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const available =
      el.scrollHeight - el.scrollTop - el.clientHeight >
      SCROLL_TO_LATEST_THRESHOLD_PX;
    if (canScrollDownRef.current !== available) {
      canScrollDownRef.current = available;
      latestRef.current.onScrollAvailabilityChange?.(available);
    }
  }, []);

  const debouncedCheckScroll = useDebouncedCallback(
    checkScrollAvailability,
    100,
  );
  const debouncedRecordScrollTop = useDebouncedCallback(() => {
    const el = viewportRef.current;
    if (el) latestRef.current.onScrollEnd?.(el.scrollTop);
  }, 150);

  useEffect(
    () => () => {
      debouncedCheckScroll.cancel();
      debouncedRecordScrollTop.cancel();
    },
    [debouncedCheckScroll, debouncedRecordScrollTop],
  );

  useEffect(() => {
    canScrollDownRef.current = false;
    onScrollAvailabilityChange?.(false);
  }, [isHistoryLoading, onScrollAvailabilityChange]);

  useEffect(() => {
    if (chatContextValue.status === "transmitting") {
      checkScrollAvailability();
    }
  }, [chatContextValue, checkScrollAvailability]);

  useEffect(() => {
    let active = true;
    Promise.resolve(AIProvider.userInfo)
      .then((info) => {
        if (!active) return;
        setAvatarUrl(info?.avatarUrl ?? "");
        setUserName(info?.name ?? "");
      })
      .catch(console.error);

    const sub = AIProvider.slots.userInfo.subscribe((info) => {
      setAvatarUrl(info?.avatarUrl ?? "");
      setUserName(info?.name ?? "");
      const { status, error } = latestRef.current.chatContextValue;
      if (status === "error" && error instanceof UnauthorizedError && info) {
        latestRef.current.updateContext({ status: "idle", error: null });
      }
    });

    return () => {
      active = false;
      sub.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!host) return;
    const subs: Array<{ unsubscribe: () => void } | undefined> = [];
    if (host.selection.slots.changed) {
      subs.push(
        host.selection.slots.changed.subscribe(() =>
          bumpHostRevision((n) => n + 1),
        ),
      );
    }
    const modeService = host.std.get(DocModeProvider);
    if (modeService && docId) {
      subs.push(
        modeService.onPrimaryModeChange(
          () => bumpHostRevision((n) => n + 1),
          docId,
        ),
      );
    }
    return () => subs.forEach((s) => s?.unsubscribe());
  }, [docId, host]);

  const handleScroll = useCallback(() => {
    debouncedCheckScroll();
    debouncedRecordScrollTop();
  }, [debouncedCheckScroll, debouncedRecordScrollTop]);

  const handleRetry = useCallback(() => {
    const cur = latestRef.current;
    const initialSessionId = cur.session?.sessionId;
    const reqWorkspaceId = cur.workspaceId;
    const reqDocId = cur.docId;

    void retryTurn({
      workspaceId: reqWorkspaceId,
      docId: reqDocId,
      sessionId: initialSessionId,
      ensureSessionId: async () => (await cur.createSession())?.sessionId,
      previousMessages: cur.chatContextValue.messages,
      status: cur.chatContextValue.status,
      aiModelService: cur.aiModelService,
      reasoningConfig: cur.reasoningConfig,
      aiToolsConfigService: cur.aiToolsConfigService,
      where: "chat-panel",
      control: "chat-send",
      isRootSession: true,
      isScopeStillCurrent: (ownedSessionId) =>
        latestRef.current.workspaceId === reqWorkspaceId &&
        latestRef.current.docId === reqDocId &&
        (latestRef.current.session?.sessionId === initialSessionId ||
          latestRef.current.session?.sessionId === ownedSessionId),
      onPatch: (patch) => latestRef.current.updateContext(patch),
    });
  }, [retryTurn]);

  const empty = messages.length === 0;
  const { status, error } = chatContextValue;

  const viewportStyle: CSSProperties = boundedMode
    ? {
        contain: "size",
        flex: "1 1 auto",
        minHeight: "8lh",
        overscrollBehaviorY: "contain",
      }
    : independentMode && empty
      ? { flex: "0 0 auto" }
      : { flex: 1, minHeight: 0 };

  return (
    <Scrollable.Viewport
      ref={viewportRef}
      fill={!boundedMode && (!independentMode || !empty)}
      autosize={Boolean(independentMode && empty)}
      scrollbars="y"
      data-testid={testId}
      data-empty={empty ? "" : undefined}
      style={viewportStyle}
      onScroll={handleScroll}
    >
      <ChatConversation loading={isHistoryLoading} empty={empty}>
        {messages.map((item, idx) => {
          if (!isChatMessage(item)) return null;
          const isLast = idx === messages.length - 1;
          const key = stableMessageKey(item, idx);
          if (item.role === "user") {
            return (
              <ChatUserMessage
                key={key}
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
              key={key}
              item={item}
              status={isLast ? status : "idle"}
              error={isLast ? error : null}
              retry={isLast ? handleRetry : undefined}
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
