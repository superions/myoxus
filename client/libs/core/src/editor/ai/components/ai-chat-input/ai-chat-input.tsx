// SPDX-License-Identifier: MIT

import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { Box } from "@myoxus/ui-facade";
import { signal } from "@preact/signals-core";
import type { EditorHost } from "@virgultum/editor/std";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { type AIError, AIProvider, type AISendParams } from "../../provider";
import { readBlobAsURL } from "../../utils/image";
import { mergeStreamObjects } from "../../utils/stream-objects";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import { AddContext } from "../ai-chat-chips/context-options";
import type { ChatChip, DocDisplayConfig } from "../ai-chat-chips/type";
import {
  isAttachmentChip,
  isDocChip,
  isFileChip,
} from "../ai-chat-chips/utils";
import { ChatImagePreviewView } from "../ai-chat-chips/view";
import {
  type ChatMessage,
  isChatMessage,
  StreamObjectSchema,
} from "../ai-chat-messages/type";
import { ImagePreviewUrls } from "../image-preview-grid";
import { ChatPreferenceMenu } from "./preference-menu";
import type { AIChatInputContext, AIReasoningConfig } from "./type";
import { ChatInputView } from "./view";

export interface AIChatInputProps {
  independentMode?: boolean;
  host?: EditorHost | null;
  workspaceId: string;
  docId?: string;
  session: CopilotChatHistoryFragment | null | undefined;
  isContextProcessing?: boolean;
  chatContextValue: AIChatInputContext;
  chips: ChatChip[];
  createSession: () => Promise<CopilotChatHistoryFragment | null | undefined>;
  updateContext: (context: Partial<AIChatInputContext>) => void;
  addImages: (images: File[]) => void;
  addChip: (chip: ChatChip, silent?: boolean) => Promise<void>;
  reasoningConfig: AIReasoningConfig;
  docDisplayConfig: DocDisplayConfig;
  searchMenuConfig: SearchMenuConfig;
  aiDraftService?: AIDraftService;
  aiToolsConfigService: AIToolsConfigService;
  aiModelService: AIModelService;
  isRootSession?: boolean;
  onChatSuccess?: () => void;
  trackOptions?: VirgultumPresets.TrackerOptions;
  testId?: string;
  /** Optional playground synchronization hooks. */
  syncedDraft?: string;
  onSyncedDraftChange?: (value: string) => void;
  onRegisterSend?: (send: () => void) => () => void;
  onBroadcastSend?: () => void;
}

export function AIChatInput({
  independentMode,
  host,
  workspaceId,
  docId,
  session,
  isContextProcessing,
  chatContextValue,
  chips,
  createSession,
  updateContext,
  addImages,
  addChip,
  reasoningConfig,
  docDisplayConfig,
  searchMenuConfig,
  aiDraftService,
  aiToolsConfigService,
  aiModelService,
  isRootSession = true,
  onChatSuccess,
  trackOptions,
  testId = "chat-panel-input-container",
  syncedDraft,
  onSyncedDraftChange,
  onRegisterSend,
  onBroadcastSend,
}: AIChatInputProps) {
  const draft = useMemo(() => signal(""), []);
  const imagePreviewUrls = useMemo(() => new ImagePreviewUrls(), []);
  const [activeRequest, setActiveRequest] = useState<AbortController | null>(
    null,
  );

  const mountedRef = useRef(true);
  const draftRevisionRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const isActiveRequestCurrentRef = useRef<(() => boolean) | undefined>(
    undefined,
  );

  const latestRef = useRef({
    host,
    workspaceId,
    docId,
    session,
    isContextProcessing,
    chatContextValue,
    chips,
    createSession,
    updateContext,
    addImages,
    reasoningConfig,
    docDisplayConfig,
    aiDraftService,
    aiToolsConfigService,
    aiModelService,
    isRootSession,
    onChatSuccess,
    trackOptions,
  });
  latestRef.current = {
    host,
    workspaceId,
    docId,
    session,
    isContextProcessing,
    chatContextValue,
    chips,
    createSession,
    updateContext,
    addImages,
    reasoningConfig,
    docDisplayConfig,
    aiDraftService,
    aiToolsConfigService,
    aiModelService,
    isRootSession,
    onChatSuccess,
    trackOptions,
  };

  // Subscribe to signals needed for reactive disabled/preferences UI.
  const models = useSignalValue(aiModelService.models) ?? [];
  const modelStatus = useSignalValue(aiModelService.status) ?? "idle";
  const tools = useSignalValue(aiToolsConfigService.config) ?? {};
  const isReasoningActive = !!(
    useSignalValue(reasoningConfig.enabled) ?? false
  );
  const draftValue = useSyncExternalStore(
    useCallback((notify) => draft.subscribe(notify), [draft]),
    () => draft.value,
  );

  useEffect(() => {
    if (syncedDraft !== undefined && syncedDraft !== draft.peek()) {
      draftRevisionRef.current++;
      draft.value = syncedDraft;
    }
  }, [draft, syncedDraft]);

  const stopRequest = useCallback((controller: AbortController) => {
    const ownsRequest = activeRequestRef.current === controller;
    controller.abort();
    if (ownsRequest) {
      activeRequestRef.current = null;
      setActiveRequest(null);
      isActiveRequestCurrentRef.current = undefined;
    }
    if (
      ownsRequest ||
      latestRef.current.chatContextValue.abortController === controller
    ) {
      latestRef.current.updateContext({
        abortController: null,
        status: "idle",
      });
    }
  }, []);

  // Abort active request if workspace/doc/session scope changes incompatibly.
  useEffect(() => {
    const active = activeRequestRef.current;
    if (active && !isActiveRequestCurrentRef.current?.()) {
      stopRequest(active);
    }
  }, [workspaceId, docId, session?.sessionId, stopRequest]);

  useEffect(() => {
    mountedRef.current = true;
    const revision = draftRevisionRef.current;
    aiDraftService
      ?.getDraft()
      .then((restored) => {
        if (mountedRef.current && revision === draftRevisionRef.current) {
          draft.value = restored.input;
        }
      })
      .catch(console.error);

    return () => {
      mountedRef.current = false;
      imagePreviewUrls.dispose();
      draftRevisionRef.current++;
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
      isActiveRequestCurrentRef.current = undefined;
    };
  }, [aiDraftService, draft, imagePreviewUrls]);

  const supportsVision = aiModelService.supportsVision;
  const imageInputUnsupported = useMemo(() => {
    const hasImages =
      chatContextValue.images.length > 0 ||
      chatContextValue.messages.some(
        (message) =>
          isChatMessage(message) &&
          message.role === "user" &&
          !!message.attachments?.length,
      );
    return hasImages && !supportsVision;
  }, [supportsVision, chatContextValue.images, chatContextValue.messages]);

  const generating =
    !!activeRequest ||
    chatContextValue.status === "loading" ||
    chatContextValue.status === "transmitting";

  const isSendDisabled =
    generating ||
    !draftValue.trim() ||
    !!isContextProcessing ||
    imageInputUnsupported;

  const getMatchedContexts = useCallback(async () => {
    const { chips: currentChips, docDisplayConfig: config } = latestRef.current;
    const docContexts = new Map<
      string,
      { docId: string; docContent: string }
    >();

    currentChips.forEach((chip) => {
      if (isDocChip(chip)) {
        docContexts.set(chip.docId, {
          docId: chip.docId,
          docContent: chip.markdown?.value ?? "",
        });
      }
    });

    const docs: VirgultumPresets.AIDocContextOption[] = Array.from(
      docContexts.values(),
    ).map((doc) => {
      const docMeta = config.getDocMeta(doc.docId);
      const docTitle = config.getTitle(doc.docId);
      const tags = docMeta?.tags
        ? docMeta.tags.map((tagId) => config.getTagTitle(tagId)).join(",")
        : "";
      return {
        docId: doc.docId,
        docContent: doc.docContent,
        docTitle,
        tags,
        createDate: docMeta?.createDate
          ? new Date(docMeta.createDate).toISOString()
          : "",
        updatedDate: docMeta?.updatedDate
          ? new Date(docMeta.updatedDate).toISOString()
          : "",
      };
    });

    const files: VirgultumPresets.AIFileContextOption[] = currentChips.flatMap(
      (chip) => {
        if (chip.state !== "finished") return [];
        if (isFileChip(chip) && chip.blobId)
          return [
            {
              blobId: chip.blobId,
              fileName: chip.file.name,
              fileType: chip.file.type,
              fileContent: "",
            },
          ];
        if (isAttachmentChip(chip))
          return [
            {
              blobId: chip.sourceId,
              fileName: chip.name,
              fileType: "",
              fileContent: "",
            },
          ];
        return [];
      },
    );
    return { docs, files };
  }, []);

  const preUpdateMessages = useCallback(
    async (
      userInput: string,
      attachments: string[],
      previous: AIChatInputContext["messages"],
      isCurrent: () => boolean,
      requestId: string,
    ) => {
      const userInfo = await AIProvider.userInfo;
      if (!isCurrent()) return undefined;
      const messages: AIChatInputContext["messages"] = [
        ...previous,
        {
          id: "",
          role: "user",
          content: userInput,
          params: { inputRequestId: requestId },
          createdAt: new Date().toISOString(),
          attachments,
          userId: userInfo?.id,
          userName: userInfo?.name,
          avatarUrl: userInfo?.avatarUrl ?? undefined,
        },
        {
          id: "",
          role: "assistant",
          content: "",
          params: { requestId },
          createdAt: new Date().toISOString(),
        },
      ];
      latestRef.current.updateContext({ messages });
      return messages;
    },
    [],
  );

  const postUpdateMessages = useCallback(
    async (
      sessionId: string,
      messages: AIChatInputContext["messages"],
      isCurrent: () => boolean,
      requestId: string,
    ) => {
      if (!sessionId || !AIProvider.histories) return;
      const histories = await AIProvider.histories.chats(
        latestRef.current.workspaceId,
        sessionId,
      );
      if (!isCurrent()) return;
      const stored = (histories?.[0]?.messages ?? []) as ChatMessage[];
      const user = stored.find(
        (message) =>
          message.role === "user" &&
          message.params?.inputRequestId === requestId,
      );
      const assistant = stored.find(
        (message) =>
          message.role === "assistant" &&
          message.params?.responseTo === user?.id,
      );
      if (!user || !assistant)
        throw new Error("The response identity could not be reconciled");
      const localUser = messages.at(-2) as ChatMessage;
      const last = messages.at(-1) as ChatMessage;
      latestRef.current.updateContext({
        messages: [
          ...messages.slice(0, -2),
          { ...localUser, id: user.id, params: user.params },
          { ...last, id: assistant.id, params: assistant.params },
        ],
      });
    },
    [],
  );

  const send = useCallback(
    async (text: string, clearDraft = false) => {
      const cur = latestRef.current;
      const isBusyNow =
        !!activeRequestRef.current ||
        cur.chatContextValue.status === "loading" ||
        cur.chatContextValue.status === "transmitting";
      const hasImages =
        cur.chatContextValue.images.length > 0 ||
        cur.chatContextValue.messages.some(
          (message) =>
            isChatMessage(message) &&
            message.role === "user" &&
            !!message.attachments?.length,
        );
      const visionUnsupported = hasImages && !cur.aiModelService.supportsVision;

      if (
        !mountedRef.current ||
        isBusyNow ||
        cur.isContextProcessing ||
        visionUnsupported ||
        !text.trim() ||
        !AIProvider.actions.chat
      ) {
        return;
      }

      const before = cur.chatContextValue;
      const originalDraft = draft.peek();
      const submittedDraftRevision = draftRevisionRef.current;
      const originalSessionId = cur.session?.sessionId;
      let ownedSessionId = originalSessionId;
      const reqWorkspaceId = cur.workspaceId;
      const reqDocId = cur.docId;
      const abortController = new AbortController();
      const requestId = nanoid();
      const modelId = cur.aiModelService.effectiveModelId;
      const reasoning = cur.aiModelService.reasoningAvailable
        ? !!cur.reasoningConfig.enabled.value
        : undefined;
      const toolsConfig = cur.aiToolsConfigService.config.value;

      activeRequestRef.current = abortController;
      setActiveRequest(abortController);

      const isCurrent = () =>
        mountedRef.current &&
        activeRequestRef.current === abortController &&
        latestRef.current.workspaceId === reqWorkspaceId &&
        latestRef.current.docId === reqDocId &&
        (latestRef.current.session?.sessionId === originalSessionId ||
          latestRef.current.session?.sessionId === ownedSessionId);
      isActiveRequestCurrentRef.current = isCurrent;

      let clearedRevision: number | undefined;
      try {
        const { markdown, images, snapshot, combinedElementsMarkdown, html } =
          before;
        cur.updateContext({
          status: "loading",
          retrievalAvailable: undefined,
          error: null,
          abortController,
        });

        const imageAttachments = await Promise.all(
          images?.map((image) => readBlobAsURL(image)),
        );
        if (!isCurrent() || abortController.signal.aborted) return;

        const sessionId = (await cur.createSession())?.sessionId;
        ownedSessionId = sessionId;
        if (!isCurrent() || abortController.signal.aborted) return;
        if (!sessionId) throw new Error("Conversation creation unavailable");

        const contexts = await getMatchedContexts();
        if (!isCurrent() || abortController.signal.aborted) return;

        let requestMessages = before.messages;
        const stream = await AIProvider.actions.chat({
          sessionId,
          requestId,
          input: text,
          contexts: {
            ...contexts,
            selectedSnapshot: snapshot || undefined,
            selectedMarkdown: combinedElementsMarkdown || markdown || undefined,
            html: html || undefined,
          },
          docId: reqDocId,
          attachments: images,
          workspaceId: reqWorkspaceId,
          stream: true,
          signal: abortController.signal,
          isRootSession: cur.isRootSession,
          where: cur.trackOptions?.where,
          control: cur.trackOptions?.control,
          reasoning,
          toolsConfig,
          modelId,
          onMessageCreated: async () => {
            if (!isCurrent() || abortController.signal.aborted) return;
            const acknowledged = await preUpdateMessages(
              text,
              imageAttachments,
              before.messages,
              isCurrent,
              requestId,
            );
            if (!acknowledged || !isCurrent() || abortController.signal.aborted)
              return;
            requestMessages = acknowledged;
            const latestCtx = latestRef.current.chatContextValue;
            latestRef.current.updateContext({
              images: latestCtx.images.filter(
                (image) => !images.includes(image),
              ),
              quote: latestCtx.quote === before.quote ? "" : latestCtx.quote,
              markdown:
                latestCtx.markdown === before.markdown
                  ? ""
                  : latestCtx.markdown,
            });
            if (
              clearDraft &&
              draftRevisionRef.current === submittedDraftRevision
            ) {
              clearedRevision = ++draftRevisionRef.current;
              draft.value = "";
              await latestRef.current.aiDraftService?.setDraft({ input: "" });
            }
          },
          onRetrievalStatus: (available) => {
            if (isCurrent() && !abortController.signal.aborted)
              latestRef.current.updateContext({
                retrievalAvailable: available,
              });
          },
        });

        for await (const chunk of stream) {
          if (abortController.signal.aborted || !isCurrent()) break;
          const messages = requestMessages.slice(0);
          const last = messages.at(-1);
          if (last && isChatMessage(last)) {
            try {
              const parsed = StreamObjectSchema.parse(JSON.parse(chunk));
              const streamObjects = mergeStreamObjects([
                ...(last.streamObjects ?? []),
                parsed,
              ]);
              messages[messages.length - 1] = { ...last, streamObjects };
            } catch {
              messages[messages.length - 1] = {
                ...last,
                content: last.content + chunk,
              };
            }
            requestMessages = messages;
            latestRef.current.updateContext({
              messages,
              status: "transmitting",
            });
          }
        }

        if (abortController.signal.aborted || !isCurrent()) return;
        await postUpdateMessages(
          sessionId,
          requestMessages,
          isCurrent,
          requestId,
        );
        if (isCurrent() && !abortController.signal.aborted) {
          latestRef.current.onChatSuccess?.();
          latestRef.current.updateContext({ status: "success" });
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (abortController.signal.aborted) {
          latestRef.current.updateContext({ status: "idle" });
          return;
        }
        if (
          clearedRevision !== undefined &&
          clearedRevision === draftRevisionRef.current
        ) {
          draftRevisionRef.current++;
          draft.value = originalDraft;
          void latestRef.current.aiDraftService
            ?.setDraft({ input: originalDraft })
            .catch(console.error);
        }
        const latestCtx = latestRef.current.chatContextValue;
        latestRef.current.updateContext({
          status: "error",
          error: error as AIError,
          images: [...new Set([...before.images, ...latestCtx.images])],
          quote: latestCtx.quote || before.quote,
          markdown: latestCtx.markdown || before.markdown,
        });
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
        if (activeRequestRef.current === abortController) {
          activeRequestRef.current = null;
          setActiveRequest(null);
          isActiveRequestCurrentRef.current = undefined;
        }
      }
    },
    [draft, getMatchedContexts, postUpdateMessages, preUpdateMessages],
  );

  useEffect(() => {
    const sendSub = AIProvider.slots.requestSendWithChat.subscribe(
      (params: AISendParams | null) => {
        if (!params) return;
        const { input, context, host: targetHost } = params;
        const cur = latestRef.current;
        const busyNow =
          !!activeRequestRef.current ||
          cur.chatContextValue.status === "loading" ||
          cur.chatContextValue.status === "transmitting";
        if (cur.host === targetHost && !busyNow && !cur.isContextProcessing) {
          const reqWorkspaceId = cur.workspaceId;
          const reqDocId = cur.docId;
          const reqSessionId = cur.session?.sessionId;
          if (context) cur.updateContext(context);
          setTimeout(() => {
            const next = latestRef.current;
            if (
              !mountedRef.current ||
              next.host !== targetHost ||
              next.workspaceId !== reqWorkspaceId ||
              next.docId !== reqDocId ||
              next.session?.sessionId !== reqSessionId
            )
              return;
            void send(input).catch(console.error);
          }, 0);
        }
        AIProvider.slots.requestSendWithChat.next(null);
      },
    );
    const openSub = AIProvider.slots.requestOpenWithChat.subscribe((params) => {
      if (!params || latestRef.current.host !== params.host) return;
      if (params.input) {
        draftRevisionRef.current++;
        draft.value = params.input;
      }
    });
    return () => {
      sendSub.unsubscribe();
      openSub.unsubscribe();
    };
  }, [draft, send]);

  const sendCurrentDraft = useCallback(() => {
    const value = draft.peek().trim();
    if (!value) return;
    void send(value, true).catch(console.error);
  }, [draft, send]);

  useEffect(() => {
    if (!onRegisterSend) return;
    return onRegisterSend(sendCurrentDraft);
  }, [onRegisterSend, sendCurrentDraft]);

  const handleInput = useCallback(
    (value: string) => {
      if (value === draft.peek()) return;
      draftRevisionRef.current++;
      draft.value = value;
      onSyncedDraftChange?.(value);
      void aiDraftService?.setDraft({ input: value }).catch(console.error);
    },
    [aiDraftService, draft, onSyncedDraftChange],
  );

  const handleAbort = useCallback(() => {
    const controller =
      activeRequestRef.current ??
      latestRef.current.chatContextValue.abortController;
    if (!controller) return;
    stopRequest(controller);
  }, [stopRequest]);

  const handlePreviewRemove = useCallback(
    (file: File) => {
      const currentImages = latestRef.current.chatContextValue.images;
      const index = currentImages.indexOf(file);
      if (index < 0) return;
      imagePreviewUrls.release(file);
      latestRef.current.updateContext({
        images: currentImages.filter((_, i) => i !== index),
      });
    },
    [imagePreviewUrls],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      event.stopPropagation();
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) addImages([blob]);
        }
      }
    },
    [addImages],
  );

  const previews = imagePreviewUrls.sync(chatContextValue.images);

  return (
    <Box data-testid={testId}>
      <ChatInputView
        draft={draft}
        quote={chatContextValue.quote}
        images={
          previews.length ? (
            <ChatImagePreviewView
              images={previews}
              onRemove={handlePreviewRemove}
              onError={imagePreviewUrls.release}
            />
          ) : null
        }
        context={
          <AddContext
            disabled={generating}
            docId={docId}
            independentMode={independentMode}
            addChip={addChip}
            addImages={addImages}
            docDisplayConfig={docDisplayConfig}
            searchMenuConfig={searchMenuConfig}
          />
        }
        preferences={
          <ChatPreferenceMenu
            models={models}
            modelId={aiModelService.effectiveModelId}
            modelStatus={modelStatus}
            onReloadModels={aiModelService.reload}
            reasoning={isReasoningActive}
            reasoningAvailable={aiModelService.reasoningAvailable}
            searchWorkspace={!!tools.searchWorkspace && !!tools.readingDocs}
            disabled={generating}
            onModelChange={aiModelService.setModel}
            onReasoningChange={(enabled) => reasoningConfig.setEnabled(enabled)}
            onSearchChange={(enabled) =>
              aiToolsConfigService.setConfig({
                searchWorkspace: enabled,
                readingDocs: enabled,
              })
            }
          />
        }
        generating={generating}
        imageInputUnsupported={imageInputUnsupported}
        retrievalUnavailable={
          chatContextValue.retrievalAvailable === false &&
          tools.searchWorkspace !== false
        }
        sendDisabled={isSendDisabled}
        onInput={handleInput}
        onSend={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isSendDisabled) return;
          const value = draft.peek().trim();
          if (!value) return;
          void send(value, true).catch(console.error);
          onBroadcastSend?.();
        }}
        onStop={handleAbort}
        onPaste={(event) => handlePaste(event.nativeEvent)}
        onRemoveQuote={() => updateContext({ quote: "", markdown: "" })}
      />
    </Box>
  );
}
