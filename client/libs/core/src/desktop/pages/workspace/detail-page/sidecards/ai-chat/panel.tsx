// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { AIChatContent } from "@myoxus/core/editor/ai/components/ai-chat-content";
import { ChatToolbar } from "@myoxus/core/editor/ai/components/ai-chat-toolbar";
import { AIProvider } from "@myoxus/core/editor/ai/provider/ai-provider";
import { NotificationServiceImpl } from "@myoxus/core/editor/view-extensions/editor-view/notification-service";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import { createPageAiBridge } from "@myoxus/core/editor/virgultum/doc-editor/page-ai-bridge";
import {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { EditorService } from "@myoxus/core/modules/editor";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { ServerService } from "@myoxus/core/modules/server";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useService, useServiceOptional } from "@myoxus/infra";
import {
  Alert,
  Box,
  Button,
  Group,
  MyoxusText,
  Stack,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type ChatSessionTransport,
  useChatSessionController,
} from "../../../chat-panel-utils";
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

export function EditorChatPanel({ editor, onLoad }: EditorChatPanelProps) {
  const framework = useFramework();
  const workbench = useService(WorkbenchService).workbench;
  const server = useService(ServerService).server;
  const owner = useServiceOptional(EditorService)?.editor;
  const peekViewService = framework.get(PeekViewService);
  const t = useI18n();

  const { closeConfirmModal, openConfirmModal } = useConfirmModal();
  const notificationService = useMemo(
    () => new NotificationServiceImpl(closeConfirmModal, openConfirmModal),
    [closeConfirmModal, openConfirmModal],
  );
  const { docDisplayConfig, searchMenuConfig, reasoningConfig } =
    useAIChatConfig();

  const [embeddingProgress, setEmbeddingProgress] = useState<[number, number]>([
    0, 0,
  ]);
  const [hasPinned, setHasPinned] = useState(false);
  const [, setEditorSyncTick] = useState(0);

  const prevSessionIdRef = useRef<string | null>(null);
  const lastDocRef = useRef<{ id: string; workspaceId: string } | null>(null);
  const loadedNotifiedRef = useRef(false);

  const doc = editor?.doc ?? owner?.doc.virgultumDoc;
  const host = editor?.host ?? null;

  const transport = useMemo<ChatSessionTransport | null>(
    () =>
      doc
        ? {
            createSessionWithHistory: async (options) =>
              AIProvider.session?.createSessionWithHistory(options),
            getSession: async (targetWorkspaceId, sessionId) =>
              AIProvider.session?.getSession(targetWorkspaceId, sessionId),
            updateSession: async (options) =>
              AIProvider.session?.updateSession(options),
            canDeleteSession: () => Boolean(AIProvider.histories),
            cleanupSession: async (sessionToDelete) => {
              await AIProvider.histories?.cleanup(
                sessionToDelete.workspaceId,
                sessionToDelete.docId || undefined,
                [sessionToDelete.sessionId],
              );
            },
          }
        : null,
    [doc],
  );

  const handleSessionApplied = useCallback(
    (nextSession: CopilotChatHistoryFragment | null) => {
      setHasPinned(Boolean(nextSession?.pinned));
    },
    [],
  );

  const handleActiveSessionDeleted = useCallback(
    ({ createFreshSession }: { createFreshSession: () => Promise<void> }) => {
      createFreshSession().catch(console.error);
    },
    [],
  );

  const controller = useChatSessionController({
    workspaceId: doc?.workspace.id,
    docId: doc?.id,
    initialSession: undefined,
    transport,
    t,
    notificationService,
    onSessionApplied: handleSessionApplied,
    onActiveSessionDeleted: handleActiveSessionDeleted,
  });

  const rebindSession = useCallback(async () => {
    if (!controller.session || !doc) {
      return;
    }
    if (controller.session.docId !== doc.id) {
      await controller.updateSession({
        sessionId: controller.session.sessionId,
        docId: doc.id,
      });
    }
  }, [controller.session, controller.updateSession, doc]);

  const handleContextChange = useCallback(
    (context: Parameters<typeof controller.onContextChange>[0]) => {
      controller.onContextChange(context);
      if (context.status === "success") {
        rebindSession().catch(console.error);
      }
    },
    [controller.onContextChange, rebindSession],
  );

  const resetPanel = useCallback(() => {
    controller.resetSessionState(undefined);
    setEmbeddingProgress([0, 0]);
    setHasPinned(false);
  }, [controller.resetSessionState]);

  const initPanel = useCallback(async () => {
    const requestSeq = controller.bumpRequestSeq();
    const requestedId = getSessionIdFromUrl(workbench);
    controller.setSessionError(false);
    try {
      const nextSession = await resolveInitialSession({
        sessionService: AIProvider.session ?? undefined,
        doc,
        workbench: workbench as WorkbenchLike,
      });
      if (!controller.isCurrentRequest(requestSeq)) {
        return;
      }
      if (nextSession === undefined) {
        return;
      }
      controller.setSession(nextSession);
      setHasPinned(Boolean(nextSession?.pinned));
      if (nextSession) {
        consumeSessionIdFromUrl(workbench, requestedId);
      }
    } catch {
      if (!controller.isCurrentRequest(requestSeq)) {
        return;
      }
      controller.setRetryHandler(() => {
        void initPanel();
      });
      controller.setSessionError(true);
    }
  }, [
    controller.bumpRequestSeq,
    controller.isCurrentRequest,
    controller.setRetryHandler,
    controller.setSession,
    controller.setSessionError,
    doc,
    workbench,
  ]);

  const openDoc = useCallback(
    async (docId: string, sessionId?: string) => {
      if (!doc) {
        return;
      }
      if (doc.id === docId) {
        if (
          controller.session?.sessionId === sessionId ||
          controller.session?.pinned
        ) {
          return;
        }
        if (sessionId) {
          await controller.openSession(sessionId);
        }
        return;
      }
      if (!sessionId) {
        workbench.open(`/${docId}`, { at: "active" });
        return;
      }
      workbench.open(`/${docId}?sessionId=${sessionId}`, { at: "active" });
    },
    [
      controller.openSession,
      controller.session?.pinned,
      controller.session?.sessionId,
      doc,
      workbench,
    ],
  );

  const expandToMainChat = useCallback(() => {
    if (!doc) {
      return;
    }
    const query = new URLSearchParams({ fromDocId: doc.id });
    if (controller.session?.sessionId) {
      query.set("sessionId", controller.session.sessionId);
    }
    const mode = new URLSearchParams(workbench.location$.value.search).get(
      "mode",
    );
    if (mode === "edgeless") {
      query.set("fromMode", mode);
    }
    workbench.open(`/chat?${query}`, { at: "active" });
    workbench.closeContextPanel();
  }, [controller.session?.sessionId, doc, workbench]);

  const onEmbeddingProgressChange = useCallback(
    (count: Record<ContextEmbedStatus, number>) => {
      setEmbeddingProgress([
        count.finished,
        count.finished + count.processing + count.failed,
      ]);
    },
    [],
  );

  useEffect(() => {
    const subscription = AIProvider.slots.userInfo.subscribe(resetPanel);
    return () => subscription.unsubscribe();
  }, [resetPanel]);

  useEffect(() => {
    if (!doc) {
      return;
    }
    const previous = lastDocRef.current;
    if (
      previous &&
      (previous.workspaceId !== doc.workspace.id ||
        (previous.id !== doc.id && !controller.session?.pinned))
    ) {
      resetPanel();
    }
    lastDocRef.current = { id: doc.id, workspaceId: doc.workspace.id };
    return () => {
      controller.bumpRequestSeq();
    };
  }, [doc?.id, doc?.workspace.id, resetPanel]);

  useEffect(() => {
    if (!doc || controller.session !== undefined) {
      return;
    }
    if (AIProvider.session) {
      initPanel().catch(console.error);
      return () => {
        controller.bumpRequestSeq();
      };
    }
    const subscription = AIProvider.slots.sessionReady.subscribe((ready) => {
      if (!ready || controller.session !== undefined) {
        return;
      }
      initPanel().catch(console.error);
    });
    return () => {
      subscription.unsubscribe();
      controller.bumpRequestSeq();
    };
  }, [controller.bumpRequestSeq, controller.session, doc, initPanel]);

  useEffect(() => {
    if (!editor?.host) {
      return;
    }
    const docModeService = editor.host.std.get(DocModeProvider);
    const refNodeService = editor.host.std.getOptional(RefNodeSlotsProvider);
    const disposables = [
      refNodeService?.docLinkClicked.subscribe(({ host: clickedHost }) => {
        if (clickedHost === editor.host) {
          setEditorSyncTick((tick) => tick + 1);
        }
      }),
      docModeService?.onPrimaryModeChange(() => {
        setEditorSyncTick((tick) => tick + 1);
      }, editor.doc.id),
    ];
    return () => {
      for (const item of disposables) {
        item?.unsubscribe();
      }
    };
  }, [editor]);

  const session = controller.session;
  const hasSessionHistory = Boolean(session?.messages?.length);
  const sessionSwitched = Boolean(
    session?.sessionId &&
    prevSessionIdRef.current &&
    prevSessionIdRef.current !== session.sessionId,
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

  const pageBridge = useMemo(
    () =>
      doc && !host
        ? createPageAiBridge({
            store: doc,
            getSelectedBlockIds: () => owner?.selectedPageBlocks() ?? [],
            getActiveBlockId: () => owner?.pageSelection?.focus.id ?? null,
            notificationService,
            peekViewService,
            serverBaseUrl: server.baseUrl,
            openDoc: (targetId) => handleOpenDoc(targetId),
          })
        : null,
    [
      doc,
      handleOpenDoc,
      host,
      notificationService,
      owner,
      peekViewService,
      server.baseUrl,
    ],
  );

  const [done, total] = embeddingProgress;
  const isEmbedding = total > 0 && done < total;
  const isInitialized = session !== undefined;

  return (
    <Stack flex={1} mih={0} data-myoxus-ui-role="chat-panel-root">
      {controller.sessionError ? (
        <Alert>
          <MyoxusText>
            {t["com.myoxus.ai.chat-panel.session-error"]()}
          </MyoxusText>
          <Button onClick={controller.retry}>{t["Retry"]()}</Button>
        </Alert>
      ) : null}
      {!isInitialized ? (
        controller.sessionError ? null : (
          <ChatLoadingState
            title={t["com.myoxus.ai.chat-panel.loading-history"]()}
          />
        )
      ) : (
        <>
          <Group justify="flex-end" data-myoxus-ui-role="chat-panel-actions">
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
            {doc ? (
              <ChatToolbar
                onExpand={expandToMainChat}
                key={doc.workspace.id}
                session={session}
                workspaceId={doc.workspace.id}
                docId={doc.id}
                status={controller.status}
                docDisplayConfig={docDisplayConfig}
                notificationService={notificationService}
                onNewSession={controller.createFreshSession}
                onTogglePin={controller.togglePin}
                onOpenSession={controller.openSession}
                onOpenDoc={openDoc}
                onSessionDelete={controller.deleteSession}
              />
            ) : null}
          </Group>
          <Box
            ref={onHostBoxRef}
            display="flex"
            flex={1}
            mih={0}
            data-myoxus-ui-role="chat-panel-content-host"
          >
            {doc ? (
              <AIChatContent
                key={contentKey}
                host={host}
                pageBridge={pageBridge}
                boundedMode
                session={session}
                createSession={controller.createSession}
                workspaceId={doc.workspace.id}
                docId={doc.id}
                reasoningConfig={reasoningConfig}
                searchMenuConfig={searchMenuConfig}
                docDisplayConfig={docDisplayConfig}
                notificationService={notificationService}
                aiDraftService={framework.get(AIDraftService)}
                aiToolsConfigService={framework.get(AIToolsConfigService)}
                peekViewService={peekViewService}
                aiModelService={framework.get(AIModelService)}
                onEmbeddingProgressChange={onEmbeddingProgressChange}
                onContextChange={handleContextChange}
                onOpenDoc={handleOpenDoc}
              />
            ) : null}
          </Box>
        </>
      )}
    </Stack>
  );
}
