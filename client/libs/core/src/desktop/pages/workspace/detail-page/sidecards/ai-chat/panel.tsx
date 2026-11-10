/**
 * EditorChatPanel — the AI chat sidebar tab for the document editor.
 *
 * Hosts retained Lit content and the shared native React session toolbar.
 *
 * Architecture:
 * - `AIChatContent` is mounted into the body ref and receives updated properties.
 *   `ChatToolbar` receives the same host-owned callbacks through React props.
 * - The panel manages the AI session lifecycle: loading the initial or pinned
 *   session, creating new sessions, switching between sessions, pinning a
 *   session, and deleting sessions.
 * - A `sessionLoadSeqRef` counter guards against race conditions when multiple
 *   async operations are in flight (e.g. changing documents quickly).
 *
 * Session state machine:
 * - `undefined` — not yet initialised (shows loading spinner).
 * - `null` — initialised but no session exists yet (first-time / new session).
 * - `CopilotChatHistoryFragment` — an active session with messages.
 *
 * The panel also:
 * - Subscribes to `AIProvider.slots.userInfo` to reset and re-init when the
 *   logged-in user changes.
 * - Forwards `RefNodeSlotsProvider.docLinkClicked` events to the workbench so
 *   links inside AI chat messages open correctly.
 * - Supports an optional AI "Playground" panel (feature-flag gated).
 *
 * @param editor - The currently active `MyoxusEditorContainer`, or `null` if
 *   the editor has not mounted yet.
 * @param onLoad - Optional callback called with the `AIChatContent` element
 *   after it is first appended to the DOM.
 */

import { useAIChatConfig } from "@myoxus/core/components/hooks/myoxus/use-ai-chat-config";
import { useAISpecs } from "@myoxus/core/components/hooks/myoxus/use-ai-specs";
import { AIProvider } from "@myoxus/core/editor/ai";
import type { AppSidebarConfig } from "@myoxus/core/editor/ai/chat-panel/chat-config";
import {
  AIChatContent,
  type ChatContextValue,
} from "@myoxus/core/editor/ai/components/ai-chat-content";
import type { ChatStatus } from "@myoxus/core/editor/ai/components/ai-chat-messages";
import { ChatToolbar } from "@myoxus/core/editor/ai/components/ai-chat-toolbar";
import { createPlaygroundModal } from "@myoxus/core/editor/ai/components/playground/modal";
import { registerAIAppEffects } from "@myoxus/core/editor/ai/effects/app";
import { NotificationServiceImpl } from "@myoxus/core/editor/view-extensions/editor-view/notification-service";
import type { MyoxusEditorContainer } from "@myoxus/core/editor/virgultum/doc-editor";
import {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { ServerService } from "@myoxus/core/modules/server";
import { AppThemeService } from "@myoxus/core/modules/theme";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
  UpdateChatSessionInput,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { CenterPeekIcon } from "@myoxus/icons/react";
import { useFramework, useService } from "@myoxus/infra";
import { useLitPortalFactory } from "@myoxus/lit-react";
import {
  Box,
  Alert,
  Button,
  Group,
  IconButton,
  MyoxusText,
  Stack,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { signal } from "@preact/signals-core";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import { DocModeProvider } from "@virgultum/editor/shared/services";
import { createSignalFromObservable } from "@virgultum/editor/shared/utils";
import { html } from "lit";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { createSessionDeleteHandler } from "../../../chat-panel-utils";
import { ChatLoadingState } from "./loading-state";
import {
  consumeSessionIdFromUrl,
  getSessionIdFromUrl,
  resolveInitialSession,
  type WorkbenchLike,
} from "./session";

registerAIAppEffects();

export interface EditorChatPanelProps {
  editor: MyoxusEditorContainer | null;
  onLoad?: ((component: HTMLElement) => void) | null;
}

export const EditorChatPanel = ({ editor, onLoad }: EditorChatPanelProps) => {
  const [reactToLit, portals] = useLitPortalFactory();
  const framework = useFramework();
  const workbench = useService(WorkbenchService).workbench;
  const t = useI18n();

  const { closeConfirmModal, openConfirmModal } = useConfirmModal();
  const notificationService = useMemo(
    () => new NotificationServiceImpl(closeConfirmModal, openConfirmModal),
    [closeConfirmModal, openConfirmModal],
  );
  const specs = useAISpecs();
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
  const retrySessionRef = useRef<() => void>(() => {});

  const [chatContent, setChatContent] = useState<AIChatContent | null>(null);
  const [isBodyProvided, setIsBodyProvided] = useState(false);

  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const contentKeyRef = useRef<string | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  const lastDocRef = useRef<{ id: string; workspaceId: string } | null>(null);
  const sessionLoadSeqRef = useRef(0);

  const doc = editor?.doc;
  const host = editor?.host;

  const intrinsicPanelWidth = useMemo(
    () => signal<number | undefined>(undefined),
    [],
  );
  const appSidebarConfig = useMemo<AppSidebarConfig>(() => {
    return {
      getWidth: () => ({ signal: intrinsicPanelWidth, cleanup: () => {} }),
      isOpen: () =>
        createSignalFromObservable<boolean | undefined>(
          workbench.contextPanelOpen$.asObservable(),
          true,
        ),
    };
  }, [intrinsicPanelWidth, workbench]);

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
      if (nextSession === undefined) {
        return;
      }

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
      if (!doc) {
        return;
      }
      if (doc.id === docId) {
        if (session?.sessionId === sessionId || session?.pinned) {
          return;
        }
        if (sessionId) {
          await openSession(sessionId);
        }
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
    if (!session || !doc) {
      return;
    }
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
    if (session !== undefined) {
      return;
    }
    if (chatContent) {
      chatContent.remove();
      setChatContent(null);
    }
  }, [chatContent, session]);

  useEffect(() => {
    const subscription = AIProvider.slots.userInfo.subscribe(() => {
      resetPanel();
    });
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
        (previous.id !== doc.id && !session?.pinned))
    ) {
      resetPanel();
    }
    lastDocRef.current = { id: doc.id, workspaceId: doc.workspace.id };
    // Invalidate even pinned requests on navigation; the visible pinned session
    // may survive, but an old document's pending response must not replace it.
    return () => {
      sessionLoadSeqRef.current += 1;
    };
  }, [doc?.id, doc?.workspace.id, resetPanel]);

  useEffect(() => {
    if (!doc || session !== undefined) {
      return;
    }
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

  useEffect(() => {
    if (!chatContent) {
      contentKeyRef.current = contentKey;
      return;
    }
    if (contentKeyRef.current && contentKeyRef.current !== contentKey) {
      chatContent.remove();
      setChatContent(null);
    }
    contentKeyRef.current = contentKey;
  }, [chatContent, contentKey]);

  useEffect(() => {
    if (!isBodyProvided || !chatContainerRef.current || !doc || !host) {
      return;
    }
    if (session === undefined) {
      return;
    }

    let content = chatContent;

    if (!content) {
      content = new AIChatContent();
    }
    content.host = host;
    content.boundedMode = true;
    content.reactToLit = reactToLit;
    content.session = session;
    content.createSession = createSession;
    content.workspaceId = doc.workspace.id;
    content.docId = doc.id;
    content.reasoningConfig = reasoningConfig;
    content.searchMenuConfig = searchMenuConfig;
    content.docDisplayConfig = docDisplayConfig;
    content.extensions = specs;
    content.serverService = framework.get(ServerService);
    content.myoxusFeatureFlagService = framework.get(FeatureFlagService);
    content.myoxusWorkspaceDialogService = framework.get(
      WorkspaceDialogService,
    );
    content.myoxusThemeService = framework.get(AppThemeService);
    content.notificationService = notificationService;
    content.aiDraftService = framework.get(AIDraftService);
    content.aiToolsConfigService = framework.get(AIToolsConfigService);
    content.peekViewService = framework.get(PeekViewService);
    content.aiModelService = framework.get(AIModelService);
    content.onEmbeddingProgressChange = onEmbeddingProgressChange;
    content.onContextChange = onContextChange;
    content.width = intrinsicPanelWidth;
    content.onOpenDoc = (docId: string, sessionId?: string) => {
      openDoc(docId, sessionId).catch(console.error);
    };

    if (!chatContent) {
      chatContainerRef.current.append(content);
      setChatContent(content);
      onLoad?.(content);
    }
  }, [
    chatContent,
    createSession,
    doc,
    docDisplayConfig,
    framework,
    host,
    isBodyProvided,
    notificationService,
    onContextChange,
    onEmbeddingProgressChange,
    onLoad,
    openDoc,
    reasoningConfig,
    searchMenuConfig,
    session,
    intrinsicPanelWidth,
    specs,
    reactToLit,
  ]);

  useEffect(() => {
    if (!editor?.host || !chatContent) {
      return;
    }
    const docModeService = editor.host.std.get(DocModeProvider);
    const refNodeService = editor.host.std.getOptional(RefNodeSlotsProvider);
    const disposable = [
      refNodeService?.docLinkClicked.subscribe(({ host: clickedHost }) => {
        if (clickedHost === editor.host) {
          chatContent.docId = editor.doc.id;
        }
      }),
      docModeService?.onPrimaryModeChange(() => {
        if (!editor.host) {
          return;
        }
        chatContent.host = editor.host;
      }, editor.doc.id),
    ];

    return () => disposable.forEach((item) => item?.unsubscribe());
  }, [chatContent, editor]);

  const openPlayground = useCallback(() => {
    if (!doc || !host) {
      return;
    }
    const playgroundContent = html`
      <playground-content
        .reactToLit=${reactToLit}
        .host=${host}
        .doc=${doc}
        .reasoningConfig=${reasoningConfig}
        .playgroundConfig=${playgroundConfig}
        .appSidebarConfig=${appSidebarConfig}
        .searchMenuConfig=${searchMenuConfig}
        .docDisplayConfig=${docDisplayConfig}
        .extensions=${specs}
        .serverService=${framework.get(ServerService)}
        .myoxusFeatureFlagService=${framework.get(FeatureFlagService)}
        .myoxusThemeService=${framework.get(AppThemeService)}
        .notificationService=${notificationService}
        .myoxusWorkspaceDialogService=${framework.get(WorkspaceDialogService)}
        .aiToolsConfigService=${framework.get(AIToolsConfigService)}
        .aiModelService=${framework.get(AIModelService)}
      ></playground-content>
    `;

    createPlaygroundModal(
      playgroundContent,
      t["com.myoxus.ai.chat-panel.playground"](),
    );
  }, [
    appSidebarConfig,
    doc,
    docDisplayConfig,
    framework,
    host,
    notificationService,
    playgroundConfig,
    reasoningConfig,
    searchMenuConfig,
    specs,
    t,
  ]);

  const onChatContainerRef = useCallback((node: HTMLDivElement) => {
    if (!node) {
      return;
    }
    setIsBodyProvided(true);
    chatContainerRef.current = node;
  }, []);

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
      {portals.map(({ id, portal }) => (
        <Fragment key={id}>{portal}</Fragment>
      ))}
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
                onClick={openPlayground}
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
            ref={onChatContainerRef}
            display="flex"
            mih={0}
            style={{ flex: "1 1 auto" }}
            data-myoxus-ui-role="chat-panel-content-host"
          />
        </>
      )}
    </Stack>
  );
};
