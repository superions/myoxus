// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { ChatContextValue } from "@myoxus/core/editor/ai/components/ai-chat-content";
import type { ChatStatus } from "@myoxus/core/editor/ai/components/ai-chat-messages";
import type { PromptKey } from "@myoxus/core/editor/ai/provider/prompt";
import type {
  CopilotChatHistoryFragment,
  UpdateChatSessionInput,
} from "@myoxus/graphql";
import type { I18nInstance } from "@myoxus/i18n";
import type { NotificationService } from "@virgultum/editor/shared/services";
import { useCallback, useMemo, useRef, useState } from "react";

export type SessionDeleteCleanupFn = (
  session: VirgultumPresets.AIRecentSession,
) => Promise<void>;

export interface CreateSessionDeleteHandlerOptions {
  t: I18nInstance;
  notificationService: NotificationService;
  cleanupSession: SessionDeleteCleanupFn;
  canDeleteSession?: (session: VirgultumPresets.AIRecentSession) => boolean;
  isActiveSession?: (session: VirgultumPresets.AIRecentSession) => boolean;
  onActiveSessionDeleted?: () => void;
}

/**
 * Shared confirmation and server-cleanup flow for deleting a chat session from
 * either the workspace `/chat` page or the document AI sidecard.
 */
export function createSessionDeleteHandler({
  t,
  notificationService,
  cleanupSession,
  canDeleteSession,
  isActiveSession,
  onActiveSessionDeleted,
}: CreateSessionDeleteHandlerOptions) {
  return async (sessionToDelete: VirgultumPresets.AIRecentSession) => {
    if (canDeleteSession && !canDeleteSession(sessionToDelete)) {
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.failed"](),
      );
      return;
    }

    const confirmed = await notificationService.confirm({
      title: t["com.myoxus.ai.chat-panel.session.delete.confirm.title"](),
      message: t["com.myoxus.ai.chat-panel.session.delete.confirm.message"](),
      confirmText: t["Delete"](),
      cancelText: t["Cancel"](),
    });
    if (!confirmed) {
      return;
    }

    try {
      await cleanupSession(sessionToDelete);
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.success"](),
      );
    } catch (error) {
      console.error(error);
      notificationService.toast(
        t["com.myoxus.ai.chat-panel.session.delete.toast.failed"](),
      );
      return;
    }

    if (isActiveSession?.(sessionToDelete)) {
      onActiveSessionDeleted?.();
    }
  };
}

export interface ChatSessionTransport {
  createSessionWithHistory: (
    options: VirgultumPresets.AICreateSessionOptions,
  ) => Promise<CopilotChatHistoryFragment | null | undefined>;
  getSession: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<CopilotChatHistoryFragment | null | undefined>;
  updateSession: (options: UpdateChatSessionInput) => Promise<unknown>;
  cleanupSession: SessionDeleteCleanupFn;
  canDeleteSession?: (session: VirgultumPresets.AIRecentSession) => boolean;
}

export interface UseChatSessionControllerOptions {
  workspaceId?: string;
  docId?: string;
  initialSession?: CopilotChatHistoryFragment | null | undefined;
  transport: ChatSessionTransport | null;
  t: I18nInstance;
  notificationService: NotificationService;
  onSessionApplied?: (
    session: CopilotChatHistoryFragment | null,
    reason: "create" | "open" | "pin" | "fresh",
  ) => void;
  onActiveSessionDeleted?: (helpers: {
    clearSession: () => void;
    createFreshSession: () => Promise<void>;
  }) => void;
  onStatusSuccess?: () => void;
}

const DEFAULT_PROMPT_NAME: PromptKey = "Chat With Myoxus AI";

/**
 * Shared AI chat session controller unifying request sequencing, error retry,
 * pin toggling, fresh session creation, opening and deletion across `/chat`
 * and `EditorChatPanel`.
 */
export function useChatSessionController({
  workspaceId,
  docId,
  initialSession,
  transport,
  t,
  notificationService,
  onSessionApplied,
  onActiveSessionDeleted,
  onStatusSuccess,
}: UseChatSessionControllerOptions) {
  const [session, setSession] = useState<
    CopilotChatHistoryFragment | null | undefined
  >(initialSession);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [sessionError, setSessionError] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const requestSeqRef = useRef(0);
  const retryRef = useRef<() => void>(() => {});

  const bumpRequestSeq = useCallback(() => {
    requestSeqRef.current += 1;
    return requestSeqRef.current;
  }, []);

  const isCurrentRequest = useCallback(
    (seq: number) => seq === requestSeqRef.current,
    [],
  );

  const resetSessionState = useCallback(
    (nextValue: CopilotChatHistoryFragment | null | undefined = undefined) => {
      bumpRequestSeq();
      setSession(nextValue);
      setSessionError(false);
      setIsBusy(false);
    },
    [bumpRequestSeq],
  );

  const createSession = useCallback(
    async (options: Partial<VirgultumPresets.AICreateSessionOptions> = {}) => {
      if (session) {
        return session;
      }
      if (!transport || !workspaceId) {
        return undefined;
      }
      const seq = bumpRequestSeq();
      const created = await transport.createSessionWithHistory({
        workspaceId,
        ...(docId ? { docId } : {}),
        promptName: DEFAULT_PROMPT_NAME,
        reuseLatestChat: false,
        ...options,
      });
      if (!isCurrentRequest(seq)) {
        return undefined;
      }
      if (!created) {
        throw new Error("Conversation creation unavailable");
      }
      setSession(created);
      onSessionApplied?.(created, "create");
      return created;
    },
    [
      bumpRequestSeq,
      docId,
      isCurrentRequest,
      onSessionApplied,
      session,
      transport,
      workspaceId,
    ],
  );

  const updateSession = useCallback(
    async (options: UpdateChatSessionInput) => {
      if (!transport || !workspaceId) {
        return undefined;
      }
      const seq = bumpRequestSeq();
      await transport.updateSession(options);
      const updated = await transport.getSession(
        workspaceId,
        options.sessionId,
      );
      if (!isCurrentRequest(seq)) {
        return undefined;
      }
      if (!updated) {
        throw new Error("Requested conversation unavailable");
      }
      setSession(updated);
      onSessionApplied?.(updated, "pin");
      return updated;
    },
    [
      bumpRequestSeq,
      isCurrentRequest,
      onSessionApplied,
      transport,
      workspaceId,
    ],
  );

  const createFreshSession = useCallback(async () => {
    if (isBusy || !transport || !workspaceId) {
      return;
    }
    const seq = bumpRequestSeq();
    setIsBusy(true);
    setSessionError(false);
    try {
      const created = await transport.createSessionWithHistory({
        workspaceId,
        ...(docId ? { docId } : {}),
        promptName: DEFAULT_PROMPT_NAME,
        reuseLatestChat: false,
      });
      if (!isCurrentRequest(seq)) {
        return;
      }
      if (!created) {
        throw new Error("Conversation creation unavailable");
      }
      setSession(created);
      onSessionApplied?.(created, "fresh");
    } catch {
      if (!isCurrentRequest(seq)) {
        return;
      }
      retryRef.current = () => {
        void createFreshSession();
      };
      setSessionError(true);
    } finally {
      if (isCurrentRequest(seq)) {
        setIsBusy(false);
      }
    }
  }, [
    bumpRequestSeq,
    docId,
    isBusy,
    isCurrentRequest,
    onSessionApplied,
    transport,
    workspaceId,
  ]);

  const openSession = useCallback(
    async (sessionId: string) => {
      if (
        isBusy ||
        session?.sessionId === sessionId ||
        !transport ||
        !workspaceId
      ) {
        return;
      }
      const seq = bumpRequestSeq();
      setIsBusy(true);
      setSessionError(false);
      try {
        const loaded = await transport.getSession(workspaceId, sessionId);
        if (!isCurrentRequest(seq)) {
          return;
        }
        if (!loaded) {
          throw new Error("Requested conversation unavailable");
        }
        setSession(loaded);
        onSessionApplied?.(loaded, "open");
      } catch {
        if (!isCurrentRequest(seq)) {
          return;
        }
        retryRef.current = () => {
          void openSession(sessionId);
        };
        setSessionError(true);
      } finally {
        if (isCurrentRequest(seq)) {
          setIsBusy(false);
        }
      }
    },
    [
      bumpRequestSeq,
      isBusy,
      isCurrentRequest,
      onSessionApplied,
      session?.sessionId,
      transport,
      workspaceId,
    ],
  );

  const togglePin = useCallback(async () => {
    if (isBusy || !transport || !workspaceId) {
      return;
    }
    const seq = bumpRequestSeq();
    setIsBusy(true);
    setSessionError(false);
    try {
      const nextPinned = !session?.pinned;
      if (!session) {
        const created = await transport.createSessionWithHistory({
          workspaceId,
          ...(docId ? { docId } : {}),
          promptName: DEFAULT_PROMPT_NAME,
          reuseLatestChat: false,
          pinned: nextPinned,
        });
        if (!isCurrentRequest(seq)) {
          return;
        }
        if (!created) {
          throw new Error("Conversation creation unavailable");
        }
        setSession(created);
        onSessionApplied?.(created, "pin");
      } else {
        await transport.updateSession({
          sessionId: session.sessionId,
          pinned: nextPinned,
        });
        const refreshed = await transport.getSession(
          workspaceId,
          session.sessionId,
        );
        if (!isCurrentRequest(seq)) {
          return;
        }
        if (!refreshed) {
          throw new Error("Requested conversation unavailable");
        }
        setSession(refreshed);
        onSessionApplied?.(refreshed, "pin");
      }
    } finally {
      if (isCurrentRequest(seq)) {
        setIsBusy(false);
      }
    }
  }, [
    bumpRequestSeq,
    docId,
    isBusy,
    isCurrentRequest,
    onSessionApplied,
    session,
    transport,
    workspaceId,
  ]);

  const deleteSession = useMemo(
    () =>
      createSessionDeleteHandler({
        t,
        notificationService,
        canDeleteSession: transport?.canDeleteSession,
        cleanupSession: async (sessionToDelete) => {
          await transport?.cleanupSession(sessionToDelete);
        },
        isActiveSession: (sessionToDelete) =>
          sessionToDelete.sessionId === session?.sessionId,
        onActiveSessionDeleted: () => {
          onActiveSessionDeleted?.({
            clearSession: () => setSession(null),
            createFreshSession,
          });
        },
      }),
    [
      createFreshSession,
      notificationService,
      onActiveSessionDeleted,
      session?.sessionId,
      t,
      transport,
    ],
  );

  const onContextChange = useCallback(
    (context: Partial<ChatContextValue>) => {
      setStatus(context.status ?? "idle");
      if (context.status === "success") {
        onStatusSuccess?.();
      }
    },
    [onStatusSuccess],
  );

  const retry = useCallback(() => {
    retryRef.current();
  }, []);

  const setRetryHandler = useCallback((handler: () => void) => {
    retryRef.current = handler;
  }, []);

  return {
    session,
    setSession,
    status,
    sessionError,
    setSessionError,
    bumpRequestSeq,
    isCurrentRequest,
    resetSessionState,
    createSession,
    updateSession,
    createFreshSession,
    openSession,
    togglePin,
    deleteSession,
    onContextChange,
    retry,
    setRetryHandler,
  };
}
