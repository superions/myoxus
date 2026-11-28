// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { AIDraftService } from "@myoxus/core/modules/ai-button";
import type { AIDraftState } from "@myoxus/core/modules/ai-button/services/ai-draft";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import type { EditorHost } from "@virgultum/editor/std";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type AIChatParams, AIProvider } from "../../provider/ai-provider";
import { extractSelectedContent } from "../../utils/extract";
import type { ChatContextValue } from "../ai-chat-content/type";
import type { ChatMessage } from "../ai-chat-messages/type";
import type {
  ArtifactPreviewPayload,
  ChatPreviewController,
} from "../ai-tools/preview-context";

export const INITIAL_CHAT_CONTEXT: ChatContextValue = {
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

export interface UseChatSessionOptions {
  host?: EditorHost | null;
  workspaceId: string;
  docId?: string;
  session: CopilotChatHistoryFragment | null | undefined;
  aiDraftService?: AIDraftService;
  onContextChange?: (context: Partial<ChatContextValue>) => void;
}

/**
 * Owns chat conversation context state, server history loading across session
 * transitions, draft persistence/restoration, `requestOpenWithChat` extraction,
 * and the side-by-side artifact preview panel state.
 */
export function useChatSession(options: UseChatSessionOptions) {
  const { host, workspaceId, docId, session, aiDraftService, onContextChange } =
    options;

  const [chatContext, setChatContext] =
    useState<ChatContextValue>(INITIAL_CHAT_CONTEXT);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyLoadFailed, setHistoryLoadFailed] = useState(false);
  const [previewState, setPreviewState] = useState<{
    open: boolean;
    ownerId: string | null;
    data: ArtifactPreviewPayload | null;
  }>({ open: false, ownerId: null, data: null });

  const mountedRef = useRef(true);
  const chatContextRef = useRef(chatContext);
  chatContextRef.current = chatContext;
  const previewStateRef = useRef(previewState);
  previewStateRef.current = previewState;

  const historyRequestSeqRef = useRef(0);
  const previousIdentityRef = useRef<string | undefined>(undefined);
  const draftRevisionRef = useRef(0);

  const historyIdentity = JSON.stringify([
    workspaceId,
    docId ?? null,
    session?.sessionId ?? null,
  ]);
  const identityRef = useRef(historyIdentity);
  identityRef.current = historyIdentity;

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

  const updateContext = useCallback((patch: Partial<ChatContextValue>) => {
    if ("quote" in patch || "images" in patch || "markdown" in patch) {
      draftRevisionRef.current += 1;
    }
    const current = chatContextRef.current;
    if (
      (patch.status === "loading" || patch.status === "transmitting") &&
      current.status !== "loading" &&
      current.status !== "transmitting"
    ) {
      historyRequestSeqRef.current += 1;
      setIsHistoryLoading(false);
    }

    const next = { ...current, ...patch };
    chatContextRef.current = next;
    setChatContext(next);
    latestRef.current.onContextChange?.(patch);

    const draftService = latestRef.current.aiDraftService;
    if (draftService) {
      const draftPatch: Partial<AIDraftState> = {};
      if ("quote" in patch) draftPatch.quote = patch.quote;
      if ("images" in patch) draftPatch.images = patch.images;
      if ("markdown" in patch) draftPatch.markdown = patch.markdown;
      if (Object.keys(draftPatch).length > 0) {
        draftService.setDraft(draftPatch).catch(console.error);
      }
    }
  }, []);

  const loadHistory = useCallback(async () => {
    const seq = ++historyRequestSeqRef.current;
    const targetIdentity = identityRef.current;
    const isCurrent = () =>
      mountedRef.current &&
      seq === historyRequestSeqRef.current &&
      targetIdentity === identityRef.current;

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
      const sorted = ((histories?.[0]?.messages ?? []) as ChatMessage[]).sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      if (isCurrent()) updateContext({ messages: sorted });
    } catch {
      if (isCurrent()) setHistoryLoadFailed(true);
    } finally {
      if (isCurrent()) setIsHistoryLoading(false);
    }
  }, [updateContext]);

  useEffect(() => {
    if (historyIdentity === previousIdentityRef.current) return;

    const prev = previousIdentityRef.current
      ? (JSON.parse(previousIdentityRef.current) as [
          string | null,
          string | null,
          string | null,
        ])
      : undefined;
    const current = chatContextRef.current;
    if (
      prev &&
      (prev[0] !== workspaceId ||
        prev[1] !== (docId ?? null) ||
        (prev[2] !== null && prev[2] !== (session?.sessionId ?? null)))
    ) {
      current.abortController?.abort();
      updateContext({
        abortController: null,
        status: "idle",
        retrievalAvailable: undefined,
      });
    }

    previousIdentityRef.current = historyIdentity;
    const latestCtx = chatContextRef.current;
    // Assigning a newly created session mid-send must not overwrite the live turn.
    if (latestCtx.status === "loading" || latestCtx.status === "transmitting") {
      historyRequestSeqRef.current += 1;
      setIsHistoryLoading(false);
      return;
    }

    if (session?.messages?.length && !latestCtx.messages.length) {
      const seeded = {
        ...latestCtx,
        messages: session.messages as ChatMessage[],
      };
      chatContextRef.current = seeded;
      setChatContext(seeded);
    }
    void loadHistory();
  }, [
    docId,
    historyIdentity,
    loadHistory,
    session,
    updateContext,
    workspaceId,
  ]);

  useEffect(() => {
    mountedRef.current = true;

    const readySub = AIProvider.slots.sessionReady.subscribe((ready) => {
      const status = chatContextRef.current.status;
      if (
        ready &&
        previousIdentityRef.current &&
        status !== "loading" &&
        status !== "transmitting"
      ) {
        void loadHistory();
      }
    });

    if (aiDraftService) {
      const revision = draftRevisionRef.current;
      aiDraftService
        .getDraft()
        .then((draft) => {
          if (!mountedRef.current || revision !== draftRevisionRef.current) {
            return;
          }
          setChatContext((prev) => {
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

    const openSub = AIProvider.slots.requestOpenWithChat.subscribe(
      (params: AIChatParams | null) => {
        if (!params) return;
        const matches = params.host
          ? latestRef.current.host === params.host
          : !latestRef.current.host &&
            (!params.docId || latestRef.current.docId === params.docId);
        if (matches) {
          if (params.context) {
            updateContext(params.context);
          } else if (params.host) {
            extractSelectedContent(params.host)
              .then((extracted) => {
                if (extracted) updateContext(extracted);
              })
              .catch(console.error);
          }
        }
        AIProvider.slots.requestOpenWithChat.next(null);
      },
    );

    return () => {
      mountedRef.current = false;
      draftRevisionRef.current += 1;
      historyRequestSeqRef.current += 1;
      chatContextRef.current.abortController?.abort();
      readySub.unsubscribe();
      openSub.unsubscribe();
    };
  }, [aiDraftService, loadHistory, updateContext]);

  const closePreviewPanel = useCallback(() => {
    setPreviewState({ open: false, ownerId: null, data: null });
    AIProvider.slots.previewPanelOpenChange.next(false);
  }, []);

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

  return {
    chatContext,
    updateContext,
    isHistoryLoading,
    historyLoadFailed,
    reloadHistory: loadHistory,
    previewState,
    previewController,
    closePreviewPanel,
  };
}
