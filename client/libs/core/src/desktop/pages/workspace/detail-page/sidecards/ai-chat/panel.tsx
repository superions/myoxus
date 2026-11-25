/**
 * EditorChatPanel — the AI chat sidebar tab for the document editor.
 *
 * Renders the shared React `AIChatContent`, `ChatToolbar`, and optional
 * `PlaygroundDialog` / `PlaygroundContent`.
 */

import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { AIProvider } from "@myoxus/core/editor/ai";
import {
  AIChatContent,
  type ChatContextValue,
} from "@myoxus/core/editor/ai/components/ai-chat-content";
import type { ChatStatus } from "@myoxus/core/editor/ai/components/ai-chat-messages";
import { ChatToolbar } from "@myoxus/core/editor/ai/components/ai-chat-toolbar";
import { PlaygroundContent } from "@myoxus/core/editor/ai/components/playground/content";
import { PlaygroundDialog } from "@myoxus/core/editor/ai/components/playground/view";
import { NotificationServiceImpl } from "@myoxus/core/editor/view-extensions/editor-view/notification-service";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
  UpdateChatSessionInput,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { CenterPeekIcon } from "@myoxus/icons/react";
import { useFramework, useService } from "@myoxus/infra";
import {
  Alert,
  Box,
  Button,
  Group,
  IconButton,
  MyoxusText,
  Stack,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createSessionDeleteHandler } from "../../../chat-panel-utils";
import { ChatLoadingState } from "./loading-state";
import {
  consumeSessionIdFromUrl,
  getSessionIdFromUrl,
  resolveInitialSession,
  type WorkbenchLike,
} from "./session";

export interface EditorChatPanelProps {
  editor: MyoxusEditorContainer | null;
  onLoad?: ((component: HTMLElement) => void) | null;
}

export const EditorChatPanel = ({ editor, onLoad }: EditorChatPanelProps) => {
  const framework = useFramework();
  const workbench = useService(WorkbenchService).workbench;
  const t = useI18n();

  const { closeConfirmModal, openConfirmModal } = useConfirmModal();
  const notificationService = useMemo(
    () => new NotificationServiceImpl(closeConfirmModal, openConfirmModal),
    [closeConfirmModal, openConfirmModal],
  );
  const {
    docDisplayConfig,
    searchMenuConfig,
    reasoningConfig,
    playgroundConfig,
  } = useAIChatConfig();
  const playgroundVisible = useSignalValue(playgroundConfig.visible) ?? false;

  const [session, setSession] = useState<
    CopilotChatHistoryFragment | null | undefined
  >(undefined);
  const [embeddingProgress, setEmbeddingProgress] = useState<[number, number]>([
    0, 0,
  ]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [hasPinned, setHasPinned] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const [, setEditorSyncTick] = useState(0);
  const retrySessionRef = useRef<() => void>(() => {});

  const prevSessionIdRef = useRef<string | null>(null);
  const lastDocRef = useRef<{ id: string; workspaceId: string } | null>(null);
  const sessionLoadSeqRef = useRef(0);
  const loadedNotifiedRef = useRef(false);

  const doc = editor?.doc;
  const host = editor?.host;

  const resetPanel = useCallback(() => {
    sessionLoadSeqRef.current += 1;
    setSession(undefined);
    setSessionError(false);
    setEmbeddingProgress([0, 0]);
    setHasPinned(false);
  }, []);

  const initPanel = useCallback(async () => {
    const requestSeq = ++sessionLoadSeqRef.current;
    const requestedId = getSessionIdFromUrl(workbench);
    setSessionError(false);
    try {
      const nextSession = await resolveInitialSession({
        sessionService: AIProvider.session ?? undefined,
        doc,
        workbench: workbench as WorkbenchLike,
      });

      if (requestSeq !== sessionLoadSeqRef.current) return;
      if (nextSession === undefined) return;

      setSession(nextSession);
      setHasPinned(!!nextSession?.pinned);
      if (nextSession) consumeSessionIdFromUrl(workbench, requestedId);
    } catch {
      if (requestSeq !== sessionLoadSeqRef.current) return;
      retrySessionRef.current = () => void initPanel();
      setSessionError(true);
    }
  }, [doc, workbench]);

  const createSession = useCallback(
    async (options: Partial<VirgultumPresets.AICreateSessionOptions> = {}) => {
      if (session || !AIProvider.session || !doc) {
        return session ?? undefined;
      }
      const requestSeq = ++sessionLoadSeqRef.current;
      const nextSession = await AIProvider.session.createSessionWithHistory({
        docId: doc.id,
        workspaceId: doc.workspace.id,
        promptName: "Chat With Myoxus AI",
        reuseLatestChat: false,
        ...options,
      });
      if (requestSeq !== sessionLoadSeqRef.current) return undefined;
      if (!nextSession) throw new Error("Conversation creation unavailable");
      setSession(nextSession);
      setHasPinned(!!nextSession?.pinned);
      return nextSession ?? undefined;
    },
    [doc, session],
  );

  const updateSession = useCallback(
    async (options: UpdateChatSessionInput) => {
      if (!AIProvider.session || !doc) {
        return undefined;
      }
      const requestSeq = ++sessionLoadSeqRef.current;
      await AIProvider.session.updateSession(options);
      const nextSession = await AIProvider.session.getSession(
        doc.workspace.id,
        options.sessionId,
      );
      if (requestSeq !== sessionLoadSeqRef.current) return undefined;
      if (!nextSession) throw new Error("Requested conversation unavailable");
      setSession(nextSession);
      setHasPinned(!!nextSession?.pinned);
      return nextSession ?? undefined;
    },
    [doc],
  );

  const newSession = useCallback(async () => {
    if (!AIProvider.session || !doc) {
      return;
    }

    const requestSeq = ++sessionLoadSeqRef.current;
    setSessionError(false);
    try {
      const nextSession = await AIProvider.session.createSessionWithHistory({
        docId: doc.id,
        workspaceId: doc.workspace.id,
        promptName: "Chat With Myoxus AI",
        reuseLatestChat: false,
      });
      if (requestSeq === sessionLoadSeqRef.current) {
        if (!nextSession) throw new Error("Conversation creation unavailable");
        setSession(nextSession);
        setHasPinned(!!nextSession?.pinned);
      }
    } catch {
      if (requestSeq !== sessionLoadSeqRef.current) return;
      retrySessionRef.current = () => void newSession();
      setSessionError(true);
    }
  }, [doc]);

  const openSession = useCallback(
    async (sessionId: string) => {
      if (session?.sessionId === sessionId || !AIProvider.session || !doc) {
        return;
      }
      const requestSeq = ++sessionLoadSeqRef.current;
      setSessionError(false);
      try {
        const nextSession = await AIProvider.session.getSession(
          doc.workspace.id,
          sessionId,
        );
        if (requestSeq !== sessionLoadSeqRef.current) return;
        if (!nextSession) throw new Error("Requested conversation unavailable");
        setSession(nextSession);
        setHasPinned(!!nextSession?.pinned);
      } catch {
        if (requestSeq !== sessionLoadSeqRef.current) return;
        retrySessionRef.current = () => void openSession(sessionId);
        setSessionError(true);
      }
    },
    [doc, session?.sessionId],
  );

  const openDoc = useCallback(
    async (docId: string, sessionId?: string) => {
      if (!doc) return;
      if (doc.id === docId) {
        if (session?.sessionId === sessionId || session?.pinned) return;
        if (sessionId) await openSession(sessionId);
        return;
      }
      if (!sessionId) {
        workbench.open(`/${docId}`, { at: "active" });
        return;
      }
      workbench.open(`/${docId}?sessionId=${sessionId}`, { at: "active" });
    },
    [doc, openSession, session?.pinned, session?.sessionId, workbench],
  );

  const deleteSession = useMemo(
    () =>
      createSessionDeleteHandler({
        t,
        notificationService,
        canDeleteSession: () => Boolean(AIProvider.histories),
        cleanupSession: async (sessionToDelete) => {
          await AIProvider.histories?.cleanup(
            sessionToDelete.workspaceId,
            sessionToDelete.docId || undefined,
            [sessionToDelete.sessionId],
          );
        },
        isActiveSession: (sessionToDelete) =>
          sessionToDelete.sessionId === session?.sessionId,
        onActiveSessionDeleted: () => {
          newSession().catch(console.error);
        },
      }),
    [newSession, notificationService, session?.sessionId, t],
  );

  const togglePin = useCallback(async () => {
    const pinned = !session?.pinned;
    if (!session) {
      await createSession({ pinned });
      return;
    }
    await updateSession({
      sessionId: session.sessionId,
      pinned,
    });
  }, [createSession, session, updateSession]);

  const expandToMainChat = useCallback(() => {
    if (!doc) return;
    const query = new URLSearchParams({ fromDocId: doc.id });
    if (session?.sessionId) query.set("sessionId", session.sessionId);
    const mode = new URLSearchParams(workbench.location$.value.search).get(
      "mode",
    );
    if (mode === "edgeless") query.set("fromMode", mode);
    workbench.open(`/chat?${query}`, { at: "active" });
    workbench.closeContextPanel();
  }, [doc, session?.sessionId, workbench]);

  const rebindSession = useCallback(async () => {
    if (!session || !doc) return;
    if (session.docId !== doc.id) {
      await updateSession({
        sessionId: session.sessionId,
        docId: doc.id,
      });
    }
  }, [doc, session, updateSession]);

  const onEmbeddingProgressChange = useCallback(
    (count: Record<ContextEmbedStatus, number>) => {
      const total = count.finished + count.processing + count.failed;
      setEmbeddingProgress([count.finished, total]);
    },
    [],
  );

  const onContextChange = useCallback(
    (context: Partial<ChatContextValue>) => {
      setStatus(context.status ?? "idle");
      if (context.status === "success") {
        rebindSession().catch(console.error);
      }
    },
    [rebindSession],
  );

  useEffect(() => {
    const subscription = AIProvider.slots.userInfo.subscribe(() => {
      resetPanel();
    });
    return () => subscription.unsubscribe();
  }, [resetPanel]);

  useEffect(() => {
    if (!doc) return;
    const previous = lastDocRef.current;
    if (
      previous &&
      (previous.workspaceId !== doc.workspace.id ||
        (previous.id !== doc.id && !session?.pinned))
    ) {
      resetPanel();
    }
    lastDocRef.current = { id: doc.id, workspaceId: doc.workspace.id };
    return () => {
      sessionLoadSeqRef.current += 1;
    };
  }, [doc?.id, doc?.workspace.id, resetPanel]);

  useEffect(() => {
    if (!doc || session !== undefined) return;
    if (AIProvider.session) {
      initPanel().catch(console.error);
      return () => {
        sessionLoadSeqRef.current += 1;
      };
    }
    const subscription = AIProvider.slots.sessionReady.subscribe((ready) => {
      if (!ready || session !== undefined) return;
      initPanel().catch(console.error);
    });
    return () => {
      subscription.unsubscribe();
      sessionLoadSeqRef.current += 1;
    };
  }, [doc, initPanel, session]);

  useEffect(() => {
    if (!editor?.host) return;
    const docModeService = editor.host.std.get(DocModeProvider);
    const refNodeService = editor.host.std.getOptional(RefNodeSlotsProvider);
    const disposable = [
      refNodeService?.docLinkClicked.subscribe(({ host: clickedHost }) => {
        if (clickedHost === editor.host) {
          setEditorSyncTick((v) => v + 1);
        }
      }),
      docModeService?.onPrimaryModeChange(() => {
        setEditorSyncTick((v) => v + 1);
      }, editor.doc.id),
    ];

    return () => disposable.forEach((item) => item?.unsubscribe());
  }, [editor]);

  const hasSessionHistory = !!session?.messages?.length;
  const sessionSwitched = !!(
    session?.sessionId &&
    prevSessionIdRef.current &&
    prevSessionIdRef.current !== session.sessionId
  );
  const contentKey =
    hasPinned || (session?.sessionId && (hasSessionHistory || sessionSwitched))
      ? (session?.sessionId ?? doc?.id ?? "chat-panel")
      : (doc?.id ?? "chat-panel");

  useEffect(() => {
    if (session?.sessionId) {
      prevSessionIdRef.current = session.sessionId;
    }
  }, [session?.sessionId]);

  const [playgroundDocId, setPlaygroundDocId] = useState<string | null>(null);

  const onHostBoxRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && !loadedNotifiedRef.current) {
        loadedNotifiedRef.current = true;
        onLoad?.(node);
      }
    },
    [onLoad],
  );

  const handleOpenDoc = useCallback(
    (docId: string, sessionId?: string) => {
      openDoc(docId, sessionId).catch(console.error);
    },
    [openDoc],
  );

  const isEmbedding =
    embeddingProgress[1] > 0 && embeddingProgress[0] < embeddingProgress[1];
  const [done, total] = embeddingProgress;
  const isInitialized = session !== undefined;

  return (
    <Stack
      mih={0}
      style={{ flex: "1 1 auto" }}
      data-myoxus-ui-role="chat-panel-root"
    >
      <PlaygroundDialog
        key={doc?.id}
        open={!!doc && playgroundDocId === doc.id}
        onOpenChange={(open) => {
          if (!open) setPlaygroundDocId(null);
        }}
        title={t["com.myoxus.ai.chat-panel.playground"]()}
      >
        {doc && host && playgroundDocId === doc.id ? (
          <PlaygroundContent
            host={host}
            doc={doc}
            peekViewService={framework.get(PeekViewService)}
            onOpenDoc={handleOpenDoc}
            reasoningConfig={reasoningConfig}
            searchMenuConfig={searchMenuConfig}
            docDisplayConfig={docDisplayConfig}
            notificationService={notificationService}
            aiToolsConfigService={framework.get(AIToolsConfigService)}
            aiModelService={framework.get(AIModelService)}
          />
        ) : null}
      </PlaygroundDialog>
      {sessionError ? (
        <Alert>
          <MyoxusText>
            {t["com.myoxus.ai.chat-panel.session-error"]()}
          </MyoxusText>
          <Button onClick={() => retrySessionRef.current()}>
            {t["Retry"]()}
          </Button>
        </Alert>
      ) : null}
      {!isInitialized ? (
        sessionError ? null : (
          <ChatLoadingState
            title={t["com.myoxus.ai.chat-panel.loading-history"]()}
          />
        )
      ) : (
        <>
          <Group
            justify="flex-end"
            style={{ flexShrink: 0 }}
            data-myoxus-ui-role="chat-panel-actions"
          >
            {isEmbedding ? (
              <MyoxusText
                component="span"
                fallbackSlot="body-small"
                tone="secondary"
                typographySlot="caption"
                data-testid="chat-panel-embedding-progress"
              >
                {t.t("com.myoxus.ai.chat-panel.embedding-progress", {
                  done,
                  total,
                })}
              </MyoxusText>
            ) : null}
            {playgroundVisible ? (
              <IconButton
                aria-label={t["com.myoxus.ai.chat-panel.playground"]()}
                tooltip={t["com.myoxus.ai.chat-panel.playground"]()}
                tooltipOptions={{ side: "left" }}
                onClick={() => {
                  if (doc && host) setPlaygroundDocId(doc.id);
                }}
              >
                <CenterPeekIcon />
              </IconButton>
            ) : null}
            {doc ? (
              <ChatToolbar
                onExpand={expandToMainChat}
                key={doc.workspace.id}
                session={session}
                workspaceId={doc.workspace.id}
                docId={doc.id}
                status={status}
                docDisplayConfig={docDisplayConfig}
                notificationService={notificationService}
                onNewSession={newSession}
                onTogglePin={togglePin}
                onOpenSession={openSession}
                onOpenDoc={openDoc}
                onSessionDelete={deleteSession}
              />
            ) : null}
          </Group>
          <Box
            ref={onHostBoxRef}
            display="flex"
            mih={0}
            style={{ flex: "1 1 auto" }}
            data-myoxus-ui-role="chat-panel-content-host"
          >
            {doc && host ? (
              <AIChatContent
                key={contentKey}
                host={host}
                boundedMode
                session={session}
                createSession={createSession}
                workspaceId={doc.workspace.id}
                docId={doc.id}
                reasoningConfig={reasoningConfig}
                searchMenuConfig={searchMenuConfig}
                docDisplayConfig={docDisplayConfig}
                notificationService={notificationService}
                aiDraftService={framework.get(AIDraftService)}
                aiToolsConfigService={framework.get(AIToolsConfigService)}
                peekViewService={framework.get(PeekViewService)}
                aiModelService={framework.get(AIModelService)}
                onEmbeddingProgressChange={onEmbeddingProgressChange}
                onContextChange={onContextChange}
                onOpenDoc={handleOpenDoc}
              />
            ) : null}
          </Box>
        </>
      )}
    </Stack>
  );
};
