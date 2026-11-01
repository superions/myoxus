import { DocEmbedProvider } from "@virgultum/editor/shared/services";
/**
 * Standalone workspace AI chat page — the `/chat` workbench route.
 *
 * Unlike `EditorChatPanel` (which is a sidebar panel anchored to an open
 * document), this page provides a full-screen, document-independent AI chat
 * experience.  It is rendered inside a `ViewBody` / `ViewHeader` pair and
 * mounts the retained Virgultum content into a React ref:
 *
 *  - `AIChatContent`  — the scrollable chat message area (body)
 * Session controls use the same native React `ChatToolbar` as document chat.
 *
 * ### "Independent mode"
 * The content component is created with `independentMode = true`, which tells
 * it not to assume a real `EditorHost` is present.  A minimal
 * `BlockStdScope` (`useMockStd`) is still required by some AI extensions that
 * read workspace-level configuration; it is created from an arbitrary open doc
 * just to satisfy the extension contracts.
 *
 * ### Session lifecycle
 * 1. On first mount the component queries the server for a pinned session.  If
 *    one exists it is restored without creating a new session.
 * 2. The user can toggle the pin state of the current session.
 * 3. "New chat" creates a fresh session and remounts `AIChatContent`.
 * 4. Session switching (from the history menu) fetches the target session,
 *    updates state, and remounts the content component.
 * 5. Deleting the active session clears state and remounts.
 *
 * ### Remounting strategy
 * `reMountChatContent` removes the old `AIChatContent` element and sets
 * `chatContent` to `null`.  The subsequent render then re-creates and mounts a
 * fresh element in the `useEffect` that initialises `AIChatContent`. Failed
 * transitions do not remount, so the conversation and unsent input survive.
 *
 * ### Doc-link navigation
 * Reference-node click events from the mock `BlockStdScope` are forwarded to
 * `workbench.openDoc(...)` so that clicking a `@mention` or doc-link inside an
 * AI response navigates to the referenced document in the active workbench tab.
 */
import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { useAISpecs } from "@myoxus/core/components/hooks/myoxus/use-ai-specs";
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import { WorkbenchToolsHeaderMenuButton } from "@myoxus/core/components/workbench-tools-menu";
import {
  RouteLogic,
  useNavigateHelper,
} from "@myoxus/core/components/hooks/use-navigate-helper";
import { CopilotClient } from "@myoxus/core/editor/ai";
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
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import {
  EventSourceService,
  FetchService,
  GraphQLService,
  ServerService,
} from "@myoxus/core/modules/server";
import { AppThemeService } from "@myoxus/core/modules/theme";
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
import { useLitPortalFactory } from "@myoxus/lit-react";
import {
  Button,
  Alert,
  IconButton,
  Group,
  DialogFooterActions,
  MyoxusTitle,
  Stack,
  useConfirmModal,
  useResponsiveElementSize,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import { type Signal, signal } from "@preact/signals-core";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { BlockStdScope } from "@virgultum/editor/std";
import type { Workspace } from "@virgultum/editor/store";
import { nanoid } from "nanoid";
import {
  type ReactNode,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { WorkbenchRouteStatus } from "../../404";
import { createSessionDeleteHandler } from "../chat-panel-utils";
import { ChatLoadingState } from "../detail-page/sidecards/ai-chat/loading-state";

/** Shorthand for the resolved session type returned by `CopilotClient.getSession`. */
type CopilotSession = Awaited<ReturnType<CopilotClient["getSession"]>>;

/**
 * Creates and memoises a `CopilotClient` from the DI-provided transport
 * services.  The client is stable as long as `GraphQLService` and
 * `EventSourceService` references are unchanged.
 */
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

/**
 * Creates a minimal `BlockStdScope` that satisfies Virgultum AI extension
 * contracts without requiring a real open editor.
 *
 * The scope is initialised from an arbitrary existing doc in the workspace
 * (`docs.values().next()`).  The doc itself is never displayed — we only need
 * the scope so that extensions like `RefNodeSlotsProvider` and view-manager
 * configurations are available to AI chat components.
 *
 * Returns `null` if the workspace has no docs yet (edge case on first launch).
 */
function createMockStd(workspace: Workspace) {
  workspace.meta.initialize();
  // just pick a random doc for now
  const store = workspace.docs.values().next().value?.getStore();
  if (!store) return null;
  const std = new BlockStdScope({
    store,
    extensions: [...getViewManager().config.init().value.get("page")],
  });
  std.render();
  return std;
}

/**
 * React hook that creates and memoises a mock `BlockStdScope` for the current
 * workspace.  Re-creates the scope only when the workspace identity changes.
 */
function useMockStd() {
  const workspace = useService(WorkspaceService).workspace;
  const std = useMemo(() => {
    if (!workspace) return null;
    return createMockStd(workspace.docCollection);
  }, [workspace]);
  return std;
}

/**
 * Lazy route component for the `/chat` workbench path.
 *
 * Orchestrates session management, Lit web component lifecycle, and all AI
 * service wiring for the standalone (document-independent) chat view.
 *
 * Key state:
 * - `currentSession` — the active `CopilotSession`; `null` when no session has
 *   been started yet.
 * - `chatContent` — the mounted Lit content, or `null` before mounting.
 * - `isBodyProvided` — prevents mounting before the body DOM ref is ready.
 * - `hasRestoredPinnedSessionRef` — guards a completed initial restore while
 *   allowing a canceled StrictMode setup to retry the sidebar handoff.
 * - `widthSignalRef` — a Preact signal that communicates the container width
 *   to the `AIChatContent` element reactively (without re-rendering React).
 */
export const WorkspaceChatPage = () => {
  const [reactToLit, portals] = useLitPortalFactory();
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
  const [isBodyProvided, setIsBodyProvided] = useState(false);
  const [chatContent, setChatContent] = useState<AIChatContent | null>(null);
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
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const widthSignalRef = useRef<Signal<number>>(signal(0));
  const { ref: chatContainerSizeRef, width: chatContainerWidth } =
    useResponsiveElementSize<HTMLDivElement>();
  const client = useCopilotClient();
  const workbench = useService(WorkbenchService).workbench;
  const initialNavigation = useRef(
    new URLSearchParams(workbench.location$.value.search),
  );
  const returnDocId = initialNavigation.current.get("fromDocId");

  const workspaceId = useService(WorkspaceService).workspace.id;

  useEffect(() => {
    hasRestoredPinnedSessionRef.current = false;
    // Cleanup also invalidates callbacks from StrictMode's abandoned setup.
    return () => {
      sessionLoadSeqRef.current += 1;
    };
  }, [workspaceId, client]);

  const { docDisplayConfig, searchMenuConfig, reasoningConfig } =
    useAIChatConfig();

  const createSession = useCallback(
    async (options: Partial<VirgultumPresets.AICreateSessionOptions> = {}) => {
      // Idempotent: if a session already exists, return it to avoid duplicates.
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
    // Debounce: ignore rapid double-taps while the RPC is in flight.
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
        // Fetch the full session object so `currentSession.pinned` reflects
        // the server state rather than an optimistic local toggle.
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

  // Remount only after a transition succeeds; failures keep the conversation
  // and its unsent input mounted.
  const reMountChatContent = useCallback(() => {
    setChatContent((prev) => {
      prev?.remove();
      return null;
    });
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
      // Skip if already loading or if the requested session is already active.
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
      // Navigate to the document and open the chat sidebar pre-seeded with
      // the session, so the user lands on the right conversation context.
      workbench.open(`/${docId}?sessionId=${sessionId}`, { at: "active" });
      viewService.view.showTool("chat");
    },
    [framework],
  );

  const specs = useAISpecs();
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

  // init or update ai-chat-content
  useEffect(() => {
    if (!isBodyProvided || !initialResolved) {
      return;
    }

    let content = chatContent;

    if (!content) {
      content = new AIChatContent();
    }

    content.session = currentSession;
    content.workspaceId = workspaceId;
    content.extensions = specs;
    content.host = mockStd?.host;
    content.reactToLit = reactToLit;
    content.docDisplayConfig = docDisplayConfig;
    content.searchMenuConfig = searchMenuConfig;
    content.reasoningConfig = reasoningConfig;
    content.onContextChange = onContextChange;
    content.myoxusFeatureFlagService = framework.get(FeatureFlagService);
    content.myoxusWorkspaceDialogService = framework.get(
      WorkspaceDialogService,
    );
    content.peekViewService = framework.get(PeekViewService);
    content.myoxusThemeService = framework.get(AppThemeService);
    content.notificationService = notificationService;
    content.aiDraftService = framework.get(AIDraftService);
    content.aiToolsConfigService = framework.get(AIToolsConfigService);
    content.serverService = framework.get(ServerService);
    content.aiModelService = framework.get(AIModelService);
    content.createSession = createSession;
    content.onOpenDoc = onOpenDoc;

    if (!chatContent) {
      // initial values that won't change
      content.independentMode = true;
      chatContainerRef.current?.append(content);
      setChatContent(content);
    }
  }, [
    chatContent,
    createSession,
    currentSession,
    docDisplayConfig,
    framework,
    isBodyProvided,
    initialResolved,
    mockStd,
    reasoningConfig,
    searchMenuConfig,
    workspaceId,
    onContextChange,
    notificationService,
    specs,
    reactToLit,
    onOpenDoc,
  ]);

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

  // Keep pinned precedence, then consume a sidebar handoff only after resolving
  // it. An aborted StrictMode setup must leave the next setup able to load it.
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

    // abort the request
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

  const onChatContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      chatContainerSizeRef(node);
      if (node) {
        setIsBodyProvided(true);
        chatContainerRef.current = node;
      }
    },
    [chatContainerSizeRef],
  );

  // Keep the Lit chat content informed; element measurement belongs to facade.
  useEffect(() => {
    if (!isBodyProvided || chatContainerWidth <= 0) return;
    widthSignalRef.current.value = chatContainerWidth;
  }, [chatContainerWidth, isBodyProvided]);

  return (
    <>
      <ViewTitle title={t["com.myoxus.sidebar.tab.chat"]()} />
      {portals.map(({ id, portal }) => (
        <Fragment key={id}>{portal}</Fragment>
      ))}
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
          {/* The bounded route, not the conversation's min-content height, owns
              this flex item. Keep long history in AIChatContent's scroller. */}
          <Stack ref={onChatContainerRef} flex={1} mih={0} />
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
