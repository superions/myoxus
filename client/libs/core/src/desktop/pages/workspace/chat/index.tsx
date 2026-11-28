import { DocEmbedProvider } from "@virgultum/editor/shared/services";
/**
 * Standalone workspace AI chat page — the `/chat` workbench route.
 *
 * Unlike `EditorChatPanel` (which is a sidebar panel anchored to an open
 * document), this page provides a full-screen, document-independent AI chat
 * experience using the shared React `AIChatContent` and `ChatToolbar`.
 */
import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { WorkbenchToolsHeaderMenuButton } from "@myoxus/core/components/workbench-tools-menu";
import {
  RouteLogic,
  useNavigateHelper,
} from "@myoxus/core/components/hooks/use-navigate-helper";
import { CopilotClient } from "@myoxus/core/editor/ai/provider/copilot-client";
import {
  AIChatContent,
  type ChatContextValue,
} from "@myoxus/core/editor/ai/components/ai-chat-content";
import type { ChatStatus } from "@myoxus/core/editor/ai/components/ai-chat-messages";
import { ChatToolbar } from "@myoxus/core/editor/ai/components/ai-chat-toolbar";
import type { PromptKey } from "@myoxus/core/editor/ai/provider/prompt";
import { getViewManager } from "@myoxus/core/editor/manager/view";
import { NotificationServiceImpl } from "@myoxus/core/editor/view-extensions/editor-view/notification-service";
import {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import {
  EventSourceService,
  FetchService,
  GraphQLService,
} from "@myoxus/core/modules/server";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewService,
  ViewTitle,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { AiIcon, ArrowLeftIcon } from "@myoxus/icons/react";
import { useFramework, useService } from "@myoxus/infra";
import {
  Alert,
  Button,
  DialogFooterActions,
  Group,
  IconButton,
  MyoxusTitle,
  Stack,
  useConfirmModal,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { BlockStdScope } from "@virgultum/editor/std";
import type { Workspace } from "@virgultum/editor/store";
import { nanoid } from "nanoid";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { WorkbenchRouteStatus } from "../../404";
import { createSessionDeleteHandler } from "../chat-panel-utils";
import { ChatLoadingState } from "../detail-page/sidecards/ai-chat/loading-state";

type CopilotSession = Awaited<ReturnType<CopilotClient["getSession"]>>;

function useCopilotClient() {
  const graphqlService = useService(GraphQLService);
  const fetchService = useService(FetchService);
  const eventSourceService = useService(EventSourceService);

  return useMemo(
    () =>
      new CopilotClient(
        graphqlService.gql,
        eventSourceService.eventSource,
        fetchService.fetch,
      ),
    [graphqlService, eventSourceService, fetchService],
  );
}

function createMockStd(workspace: Workspace) {
  workspace.meta.initialize();
  const store = workspace.docs.values().next().value?.getStore();
  if (!store) return null;
  const std = new BlockStdScope({
    store,
    extensions: [...getViewManager().config.init().value.get("page")],
  });
  std.render();
  return std;
}

function useMockStd() {
  const workspace = useService(WorkspaceService).workspace;
  return useMemo(() => {
    if (!workspace) return null;
    return createMockStd(workspace.docCollection);
  }, [workspace]);
}

export const WorkspaceChatPage = () => {
  const t = useI18n();
  const framework = useFramework();
  const confirmModal = useConfirmModal();
  const notificationService = useMemo(
    () =>
      new NotificationServiceImpl(
        confirmModal.closeConfirmModal,
        confirmModal.openConfirmModal,
      ),
    [confirmModal.closeConfirmModal, confirmModal.openConfirmModal],
  );
  const [contentRemountKey, setContentRemountKey] = useState(0);
  const [currentSession, setCurrentSession] = useState<CopilotSession | null>(
    null,
  );
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [isTogglingPin, setIsTogglingPin] = useState(false);
  const [isOpeningSession, setIsOpeningSession] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const [initialResolved, setInitialResolved] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const retrySessionRef = useRef<() => void>(() => {});
  const sessionLoadSeqRef = useRef(0);
  const hasRestoredPinnedSessionRef = useRef(false);
  const client = useCopilotClient();
  const workbench = useService(WorkbenchService).workbench;
  const initialNavigation = useRef(
    new URLSearchParams(workbench.location$.value.search),
  );
  const returnDocId = initialNavigation.current.get("fromDocId");

  const workspaceId = useService(WorkspaceService).workspace.id;

  useEffect(() => {
    hasRestoredPinnedSessionRef.current = false;
    return () => {
      sessionLoadSeqRef.current += 1;
    };
  }, [workspaceId, client]);

  const { docDisplayConfig, searchMenuConfig, reasoningConfig } =
    useAIChatConfig();

  const createSession = useCallback(
    async (options: Partial<VirgultumPresets.AICreateSessionOptions> = {}) => {
      if (currentSession) {
        return currentSession;
      }
      const requestSeq = ++sessionLoadSeqRef.current;
      const session = await client.createSessionWithHistory({
        workspaceId,
        promptName: "Chat With Myoxus AI" satisfies PromptKey,
        reuseLatestChat: false,
        ...options,
      });
      if (requestSeq !== sessionLoadSeqRef.current) return undefined;
      if (!session) throw new Error("Conversation creation unavailable");
      setCurrentSession(session);
      return session;
    },
    [client, currentSession, workspaceId],
  );

  const togglePin = useCallback(async () => {
    if (isTogglingPin) return;
    const requestSeq = ++sessionLoadSeqRef.current;
    setIsTogglingPin(true);
    setSessionError(false);
    try {
      const pinned = !currentSession?.pinned;
      if (!currentSession) {
        const session = await client.createSessionWithHistory({
          workspaceId,
          promptName: "Chat With Myoxus AI",
          reuseLatestChat: false,
          pinned,
        });
        if (requestSeq !== sessionLoadSeqRef.current) return;
        if (!session) throw new Error("Conversation creation unavailable");
        hasRestoredPinnedSessionRef.current = true;
        setInitialResolved(true);
        setCurrentSession(session);
      } else {
        await client.updateSession({
          sessionId: currentSession.sessionId,
          pinned,
        });
        const session = await client.getSession(
          workspaceId,
          currentSession.sessionId,
        );
        if (requestSeq !== sessionLoadSeqRef.current) return;
        if (!session) throw new Error("Requested conversation unavailable");
        hasRestoredPinnedSessionRef.current = true;
        setInitialResolved(true);
        setCurrentSession(session);
      }
    } finally {
      if (requestSeq === sessionLoadSeqRef.current) setIsTogglingPin(false);
    }
  }, [client, currentSession, isTogglingPin, workspaceId]);

  const reMountChatContent = useCallback(() => {
    setContentRemountKey((value) => value + 1);
  }, []);

  const createFreshSession = useCallback(async () => {
    if (isOpeningSession) {
      return;
    }
    setIsOpeningSession(true);
    setSessionError(false);
    const requestSeq = ++sessionLoadSeqRef.current;
    try {
      const session = await client.createSessionWithHistory({
        workspaceId,
        promptName: "Chat With Myoxus AI" satisfies PromptKey,
        reuseLatestChat: false,
      });
      if (requestSeq !== sessionLoadSeqRef.current) return;
      if (!session) throw new Error("Conversation creation unavailable");
      hasRestoredPinnedSessionRef.current = true;
      setInitialResolved(true);
      setCurrentSession(session);
      reMountChatContent();
    } catch {
      if (requestSeq !== sessionLoadSeqRef.current) return;
      retrySessionRef.current = () => void createFreshSession();
      setSessionError(true);
    } finally {
      if (requestSeq === sessionLoadSeqRef.current) setIsOpeningSession(false);
    }
  }, [client, isOpeningSession, reMountChatContent, workspaceId]);

  const onOpenSession = useCallback(
    async (sessionId: string) => {
      if (isOpeningSession || currentSession?.sessionId === sessionId) return;
      setIsOpeningSession(true);
      setSessionError(false);
      const requestSeq = ++sessionLoadSeqRef.current;
      try {
        const session = await client.getSession(workspaceId, sessionId);
        if (requestSeq !== sessionLoadSeqRef.current) return;
        if (!session) throw new Error("Requested conversation unavailable");
        hasRestoredPinnedSessionRef.current = true;
        setInitialResolved(true);
        setCurrentSession(session);
        reMountChatContent();
      } catch {
        if (requestSeq !== sessionLoadSeqRef.current) return;
        retrySessionRef.current = () => void onOpenSession(sessionId);
        setSessionError(true);
      } finally {
        if (requestSeq === sessionLoadSeqRef.current)
          setIsOpeningSession(false);
      }
    },
    [
      client,
      currentSession?.sessionId,
      isOpeningSession,
      reMountChatContent,
      workspaceId,
    ],
  );

  const onContextChange = useCallback((context: Partial<ChatContextValue>) => {
    setStatus(context.status ?? "idle");
  }, []);

  const onOpenDoc = useCallback(
    (docId: string) => {
      workbench.openDoc(docId, { at: "active" });
    },
    [workbench],
  );

  const onOpenSessionDoc = useCallback(
    (docId: string, sessionId: string) => {
      const { workbench } = framework.get(WorkbenchService);
      const viewService = framework.get(ViewService);
      workbench.open(`/${docId}?sessionId=${sessionId}`, { at: "active" });
      viewService.view.showTool("chat");
    },
    [framework],
  );

  const mockStd = useMockStd();
  const deleteSession = useMemo(
    () =>
      createSessionDeleteHandler({
        t,
        notificationService,
        cleanupSession: async (sessionToDelete) => {
          await client.cleanupSessions({
            workspaceId: sessionToDelete.workspaceId,
            docId: sessionToDelete.docId || undefined,
            sessionIds: [sessionToDelete.sessionId],
          });
        },
        isActiveSession: (sessionToDelete) =>
          sessionToDelete.sessionId === currentSession?.sessionId,
        onActiveSessionDeleted: () => {
          setCurrentSession(null);
          reMountChatContent();
        },
      }),
    [
      client,
      currentSession?.sessionId,
      notificationService,
      reMountChatContent,
      t,
    ],
  );

  const { jumpToPageBlock } = useNavigateHelper();
  useEffect(() => {
    const refNodeSlots = mockStd?.getOptional(RefNodeSlotsProvider);
    if (!refNodeSlots) return;
    const sub = refNodeSlots.docLinkClicked.subscribe((event) => {
      if (
        event.workspaceId !== undefined &&
        event.workspaceId !== mockStd?.workspace.id
      ) {
        const target = mockStd
          ?.getOptional(DocEmbedProvider)
          ?.inWorkspace?.(event.workspaceId);
        if (!target) return;
        void target.access
          .canRead(event.pageId)
          .then((readable) => {
            if (readable)
              jumpToPageBlock(
                event.workspaceId!,
                event.pageId,
                event.params?.mode,
                event.params?.blockIds,
                event.params?.elementIds,
              );
          })
          .catch(console.error)
          .finally(() => target.dispose());
        return;
      }
      const { workbench } = framework.get(WorkbenchService);
      workbench.openDoc({
        docId: event.pageId,
        mode: event.params?.mode,
        blockIds: event.params?.blockIds,
        elementIds: event.params?.elementIds,
        refreshKey: nanoid(),
      });
    });
    return () => sub.unsubscribe();
  }, [framework, mockStd, jumpToPageBlock]);

  useEffect(() => {
    if (hasRestoredPinnedSessionRef.current || currentSession) return;

    const controller = new AbortController();
    const requestSeq = ++sessionLoadSeqRef.current;
    const isCurrent = () =>
      !controller.signal.aborted && requestSeq === sessionLoadSeqRef.current;
    setSessionError(false);
    const loadPinnedSession = async () => {
      try {
        const sessions = await client.getSessions(
          workspaceId,
          {},
          undefined,
          { pinned: true, limit: 1 },
          controller.signal,
        );
        if (!isCurrent()) return;
        if (!Array.isArray(sessions))
          throw new Error("Session lookup unavailable");
        const requestedId = initialNavigation.current.get("sessionId");
        const restored =
          sessions[0] ??
          (requestedId
            ? await client.getSession(workspaceId, requestedId)
            : null);
        if (!isCurrent()) return;
        if (requestedId && !restored)
          throw new Error("Requested conversation unavailable");
        hasRestoredPinnedSessionRef.current = true;
        setInitialResolved(true);
        if (restored) {
          setCurrentSession((previous) => previous ?? restored);
          reMountChatContent();
          if (
            requestedId &&
            new URLSearchParams(workbench.location$.value.search).get(
              "sessionId",
            ) === requestedId
          )
            workbench.activeView$.value.updateQueryString(
              { sessionId: undefined },
              { replace: true },
            );
        }
      } catch {
        if (!isCurrent()) return;
        retrySessionRef.current = () => setRestoreAttempt((value) => value + 1);
        setSessionError(true);
      }
    };
    void loadPinnedSession();

    return () => {
      controller.abort();
    };
  }, [
    client,
    currentSession,
    reMountChatContent,
    workspaceId,
    workbench,
    restoreAttempt,
  ]);

  return (
    <>
      <ViewTitle title={t["com.myoxus.sidebar.tab.chat"]()} />
      <ViewIcon icon="ai" />
      <ViewHeader>
        <WorkbenchHeaderFrame
          data-myoxus-ui-role="workspace-chat-page-header"
          left={
            returnDocId ? (
              <IconButton
                data-testid="chat-return-document"
                aria-label={t["com.myoxus.history.back-to-page"]()}
                tooltip={
                  docDisplayConfig.getTitle(returnDocId) ||
                  t["com.myoxus.history.back-to-page"]()
                }
                onClick={() => {
                  const query = new URLSearchParams();
                  if (currentSession?.sessionId)
                    query.set("sessionId", currentSession.sessionId);
                  if (initialNavigation.current.get("fromMode") === "edgeless")
                    query.set("mode", "edgeless");
                  workbench.open(
                    `/${encodeURIComponent(returnDocId)}?${query}`,
                    { at: "active" },
                  );
                  workbench.openContextPanel();
                }}
              >
                <ArrowLeftIcon />
              </IconButton>
            ) : undefined
          }
          title={
            <MyoxusTitle order={3}>
              {t["com.myoxus.sidebar.tab.chat"]()}
            </MyoxusTitle>
          }
          right={
            <Group>
              <ChatToolbar
                key={workspaceId}
                session={currentSession}
                workspaceId={workspaceId}
                status={status}
                docDisplayConfig={docDisplayConfig}
                notificationService={notificationService}
                onNewSession={createFreshSession}
                onTogglePin={togglePin}
                onOpenSession={onOpenSession}
                onOpenDoc={onOpenSessionDoc}
                onSessionDelete={deleteSession}
              />
              <WorkbenchToolsHeaderMenuButton />
            </Group>
          }
        />
      </ViewHeader>
      <ViewBody viewportBounded>
        <Stack h="100%" w="100%" data-myoxus-ui-role="workspace-chat-page-root">
          {sessionError ? (
            <Alert>
              <Stack>
                {t["com.myoxus.ai.chat-panel.session-error"]()}
                <Group>
                  <Button onClick={() => retrySessionRef.current()}>
                    {t["Retry"]()}
                  </Button>
                </Group>
              </Stack>
            </Alert>
          ) : null}
          {!initialResolved && !sessionError ? (
            <ChatLoadingState
              title={t["com.myoxus.ai.chat-panel.loading-history"]()}
            />
          ) : null}
          <Stack flex={1} mih={0}>
            {initialResolved ? (
              <AIChatContent
                key={contentRemountKey}
                independentMode
                session={currentSession}
                workspaceId={workspaceId}
                host={mockStd?.host}
                docDisplayConfig={docDisplayConfig}
                searchMenuConfig={searchMenuConfig}
                reasoningConfig={reasoningConfig}
                onContextChange={onContextChange}
                peekViewService={framework.get(PeekViewService)}
                notificationService={notificationService}
                aiDraftService={framework.get(AIDraftService)}
                aiToolsConfigService={framework.get(AIToolsConfigService)}
                aiModelService={framework.get(AIModelService)}
                createSession={createSession}
                onOpenDoc={onOpenDoc}
              />
            ) : null}
          </Stack>
        </Stack>
      </ViewBody>
    </>
  );
};

export const WorkspaceChatAvailabilityGate = ({
  available,
  children,
}: {
  available: boolean;
  children: ReactNode;
}) => {
  const t = useI18n();
  const { jumpToIndex } = useNavigateHelper();

  if (available) {
    return children;
  }

  return (
    <WorkbenchRouteStatus
      title={t["com.myoxus.workspace.chat.unavailable.title"]()}
      description={t["com.myoxus.workspace.chat.unavailable.description"]()}
      icon={<AiIcon />}
      viewIcon="ai"
      status="access-denied"
      actions={
        <DialogFooterActions>
          <Button onClick={() => jumpToIndex(RouteLogic.REPLACE)}>
            {t["com.myoxus.notFoundPage.backButton"]()}
          </Button>
        </DialogFooterActions>
      }
    />
  );
};

export const Component = () => {
  const available = useEnableAI();
  const workspaceId = useService(WorkspaceService).workspace.id;
  return (
    <WorkspaceChatAvailabilityGate available={available}>
      <WorkspaceChatPage key={workspaceId} />
    </WorkspaceChatAvailabilityGate>
  );
};
