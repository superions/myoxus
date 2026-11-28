// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import {
  RouteLogic,
  useNavigateHelper,
} from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkbenchToolsHeaderMenuButton } from "@myoxus/core/components/workbench-tools-menu";
import { AIChatContent } from "@myoxus/core/editor/ai/components/ai-chat-content";
import { ChatToolbar } from "@myoxus/core/editor/ai/components/ai-chat-toolbar";
import { CopilotClient } from "@myoxus/core/editor/ai/provider/copilot-client";
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
import { DocEmbedProvider } from "@virgultum/editor/shared/services";
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
import {
  type ChatSessionTransport,
  useChatSessionController,
} from "../chat-panel-utils";
import { ChatLoadingState } from "../detail-page/sidecards/ai-chat/loading-state";
import { consumeSessionIdFromUrl } from "../detail-page/sidecards/ai-chat/session";

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
    [eventSourceService, fetchService, graphqlService],
  );
}

function createDocumentHostScope(workspace: Workspace) {
  workspace.meta.initialize();
  const store = workspace.docs.values().next().value?.getStore();
  if (!store) {
    return null;
  }
  const std = new BlockStdScope({
    store,
    extensions: [...getViewManager().config.init().value.get("page")],
  });
  std.render();
  return std;
}

function useWorkspaceChatHost() {
  const workspace = useService(WorkspaceService).workspace;
  return useMemo(
    () => (workspace ? createDocumentHostScope(workspace.docCollection) : null),
    [workspace],
  );
}

export function WorkspaceChatPage() {
  const t = useI18n();
  const framework = useFramework();
  const confirmModal = useConfirmModal();
  const workbench = useService(WorkbenchService).workbench;
  const workspaceId = useService(WorkspaceService).workspace.id;
  const client = useCopilotClient();
  const hostScope = useWorkspaceChatHost();
  const { jumpToPageBlock } = useNavigateHelper();
  const { docDisplayConfig, searchMenuConfig, reasoningConfig } =
    useAIChatConfig();

  const notificationService = useMemo(
    () =>
      new NotificationServiceImpl(
        confirmModal.closeConfirmModal,
        confirmModal.openConfirmModal,
      ),
    [confirmModal.closeConfirmModal, confirmModal.openConfirmModal],
  );

  const [contentRemountKey, setContentRemountKey] = useState(0);
  const [initialResolved, setInitialResolved] = useState(false);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const restoredPinnedRef = useRef(false);
  const initialQueryRef = useRef(
    new URLSearchParams(workbench.location$.value.search),
  );
  const returnDocId = initialQueryRef.current.get("fromDocId");

  const remountContent = useCallback(() => {
    setContentRemountKey((value) => value + 1);
  }, []);

  const transport = useMemo<ChatSessionTransport>(
    () => ({
      createSessionWithHistory: (options) =>
        client.createSessionWithHistory(options),
      getSession: (targetWorkspaceId, sessionId) =>
        client.getSession(targetWorkspaceId, sessionId),
      updateSession: (options) => client.updateSession(options),
      cleanupSession: async (sessionToDelete) => {
        await client.cleanupSessions({
          workspaceId: sessionToDelete.workspaceId,
          docId: sessionToDelete.docId || undefined,
          sessionIds: [sessionToDelete.sessionId],
        });
      },
    }),
    [client],
  );

  const handleSessionApplied = useCallback(
    (_nextSession: unknown, reason: "create" | "open" | "pin" | "fresh") => {
      if (reason !== "create") {
        restoredPinnedRef.current = true;
        setInitialResolved(true);
      }
      if (reason === "open" || reason === "fresh") {
        remountContent();
      }
    },
    [remountContent],
  );

  const handleActiveSessionDeleted = useCallback(
    ({ clearSession }: { clearSession: () => void }) => {
      clearSession();
      remountContent();
    },
    [remountContent],
  );

  const controller = useChatSessionController({
    workspaceId,
    initialSession: null,
    transport,
    t,
    notificationService,
    onSessionApplied: handleSessionApplied,
    onActiveSessionDeleted: handleActiveSessionDeleted,
  });

  useEffect(() => {
    restoredPinnedRef.current = false;
    return () => {
      controller.bumpRequestSeq();
    };
  }, [client, controller.bumpRequestSeq, workspaceId]);

  useEffect(() => {
    if (restoredPinnedRef.current || controller.session) {
      return;
    }

    const abortController = new AbortController();
    const requestSeq = controller.bumpRequestSeq();
    const isActive = () =>
      !abortController.signal.aborted &&
      controller.isCurrentRequest(requestSeq);

    controller.setSessionError(false);

    const restoreSession = async () => {
      try {
        const pinnedSessions = await client.getSessions(
          workspaceId,
          {},
          undefined,
          { pinned: true, limit: 1 },
          abortController.signal,
        );
        if (!isActive()) {
          return;
        }
        if (!Array.isArray(pinnedSessions)) {
          throw new Error("Session lookup unavailable");
        }
        const requestedId =
          initialQueryRef.current.get("sessionId") ?? undefined;
        const restored =
          pinnedSessions[0] ??
          (requestedId
            ? await client.getSession(workspaceId, requestedId)
            : null);
        if (!isActive()) {
          return;
        }
        if (requestedId && !restored) {
          throw new Error("Requested conversation unavailable");
        }
        restoredPinnedRef.current = true;
        setInitialResolved(true);
        if (restored) {
          controller.setSession((prev) => prev ?? restored);
          remountContent();
          consumeSessionIdFromUrl(workbench, requestedId);
        }
      } catch {
        if (!isActive()) {
          return;
        }
        controller.setRetryHandler(() => {
          setRestoreAttempt((attempt) => attempt + 1);
        });
        controller.setSessionError(true);
      }
    };

    void restoreSession();
    return () => {
      abortController.abort();
    };
  }, [
    client,
    controller.bumpRequestSeq,
    controller.isCurrentRequest,
    controller.session,
    controller.setRetryHandler,
    controller.setSession,
    controller.setSessionError,
    remountContent,
    restoreAttempt,
    workbench,
    workspaceId,
  ]);

  useEffect(() => {
    const refNodeSlots = hostScope?.getOptional(RefNodeSlotsProvider);
    if (!refNodeSlots) {
      return;
    }
    const subscription = refNodeSlots.docLinkClicked.subscribe((event) => {
      if (
        event.workspaceId !== undefined &&
        event.workspaceId !== hostScope?.workspace.id
      ) {
        const target = hostScope
          ?.getOptional(DocEmbedProvider)
          ?.inWorkspace?.(event.workspaceId);
        if (!target) {
          return;
        }
        void target.access
          .canRead(event.pageId)
          .then((readable) => {
            if (readable) {
              jumpToPageBlock(
                event.workspaceId!,
                event.pageId,
                event.params?.mode,
                event.params?.blockIds,
                event.params?.elementIds,
              );
            }
          })
          .catch(console.error)
          .finally(() => target.dispose());
        return;
      }
      framework.get(WorkbenchService).workbench.openDoc({
        docId: event.pageId,
        mode: event.params?.mode,
        blockIds: event.params?.blockIds,
        elementIds: event.params?.elementIds,
        refreshKey: nanoid(),
      });
    });
    return () => subscription.unsubscribe();
  }, [framework, hostScope, jumpToPageBlock]);

  const handleOpenDoc = useCallback(
    (docId: string) => {
      workbench.openDoc(docId, { at: "active" });
    },
    [workbench],
  );

  const handleOpenSessionDoc = useCallback(
    (docId: string, sessionId: string) => {
      const currentWorkbench = framework.get(WorkbenchService).workbench;
      const viewService = framework.get(ViewService);
      currentWorkbench.open(`/${docId}?sessionId=${sessionId}`, {
        at: "active",
      });
      viewService.view.showTool("chat");
    },
    [framework],
  );

  const handleReturnToDoc = useCallback(() => {
    if (!returnDocId) {
      return;
    }
    const query = new URLSearchParams();
    if (controller.session?.sessionId) {
      query.set("sessionId", controller.session.sessionId);
    }
    if (initialQueryRef.current.get("fromMode") === "edgeless") {
      query.set("mode", "edgeless");
    }
    workbench.open(`/${encodeURIComponent(returnDocId)}?${query}`, {
      at: "active",
    });
    workbench.openContextPanel();
  }, [controller.session?.sessionId, returnDocId, workbench]);

  const currentSession = controller.session ?? null;

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
                onClick={handleReturnToDoc}
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
                status={controller.status}
                docDisplayConfig={docDisplayConfig}
                notificationService={notificationService}
                onNewSession={controller.createFreshSession}
                onTogglePin={controller.togglePin}
                onOpenSession={controller.openSession}
                onOpenDoc={handleOpenSessionDoc}
                onSessionDelete={controller.deleteSession}
              />
              <WorkbenchToolsHeaderMenuButton />
            </Group>
          }
        />
      </ViewHeader>
      <ViewBody viewportBounded>
        <Stack h="100%" w="100%" data-myoxus-ui-role="workspace-chat-page-root">
          {controller.sessionError ? (
            <Alert>
              <Stack>
                {t["com.myoxus.ai.chat-panel.session-error"]()}
                <Group>
                  <Button onClick={controller.retry}>{t["Retry"]()}</Button>
                </Group>
              </Stack>
            </Alert>
          ) : null}
          {!initialResolved && !controller.sessionError ? (
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
                host={hostScope?.host}
                docDisplayConfig={docDisplayConfig}
                searchMenuConfig={searchMenuConfig}
                reasoningConfig={reasoningConfig}
                onContextChange={controller.onContextChange}
                peekViewService={framework.get(PeekViewService)}
                notificationService={notificationService}
                aiDraftService={framework.get(AIDraftService)}
                aiToolsConfigService={framework.get(AIToolsConfigService)}
                aiModelService={framework.get(AIModelService)}
                createSession={controller.createSession}
                onOpenDoc={handleOpenDoc}
              />
            ) : null}
          </Stack>
        </Stack>
      </ViewBody>
    </>
  );
}

export function WorkspaceChatAvailabilityGate({
  available,
  children,
}: {
  available: boolean;
  children: ReactNode;
}) {
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
}

export function Component() {
  const available = useEnableAI();
  const workspaceId = useService(WorkspaceService).workspace.id;
  return (
    <WorkspaceChatAvailabilityGate available={available}>
      <WorkspaceChatPage key={workspaceId} />
    </WorkspaceChatAvailabilityGate>
  );
}
