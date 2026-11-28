// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import type { CopilotChatHistoryFragment } from "@myoxus/graphql";
import { Box } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type AIError, AIProvider, type AISendParams } from "../../provider";
import { readBlobAsURL } from "../../utils/image";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import { AddContext } from "../ai-chat-chips/context-options";
import type { ChatChip, DocDisplayConfig } from "../ai-chat-chips/type";
import {
  isAttachmentChip,
  isDocChip,
  isFileChip,
} from "../ai-chat-chips/utils";
import { ChatImagePreviewView } from "../ai-chat-chips/view";
import { type ChatMessage, isChatMessage } from "../ai-chat-messages/type";
import { applyChatStreamChunk } from "../hooks/use-chat-stream";
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
}

function collectChatContexts(
  chips: readonly ChatChip[],
  config: DocDisplayConfig,
) {
  const docsById = new Map<string, string>();
  for (const chip of chips) {
    if (isDocChip(chip)) {
      docsById.set(chip.docId, chip.markdown?.value ?? "");
    }
  }

  const docs: VirgultumPresets.AIDocContextOption[] = Array.from(
    docsById.entries(),
  ).map(([docId, docContent]) => {
    const meta = config.getDocMeta(docId);
    return {
      docId,
      docContent,
      docTitle: config.getTitle(docId),
      tags: meta?.tags?.map((id) => config.getTagTitle(id)).join(",") ?? "",
      createDate: meta?.createDate
        ? new Date(meta.createDate).toISOString()
        : "",
      updatedDate: meta?.updatedDate
        ? new Date(meta.updatedDate).toISOString()
        : "",
    };
  });

  const files: VirgultumPresets.AIFileContextOption[] = [];
  for (const chip of chips) {
    if (chip.state !== "finished") continue;
    if (isFileChip(chip) && chip.blobId) {
      files.push({
        blobId: chip.blobId,
        fileName: chip.file.name,
        fileType: chip.file.type,
        fileContent: "",
      });
    } else if (isAttachmentChip(chip)) {
      files.push({
        blobId: chip.sourceId,
        fileName: chip.name,
        fileType: "",
        fileContent: "",
      });
    }
  }

  return { docs, files };
}

function conversationHasImages(ctx: AIChatInputContext): boolean {
  return (
    ctx.images.length > 0 ||
    ctx.messages.some(
      (msg) =>
        isChatMessage(msg) && msg.role === "user" && !!msg.attachments?.length,
    )
  );
}

/**
 * Controlled chat input orchestrator handling draft persistence, image paste
 * previews, context assembly, streaming message submission, abort, and server
 * message-ID reconciliation.
 */
export function AIChatInput(props: AIChatInputProps) {
  const {
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
  } = props;

  const [draft, setDraftState] = useState("");
  const draftRef = useRef(draft);
  const setDraft = useCallback((next: string) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);

  const previewUrls = useMemo(() => new ImagePreviewUrls(), []);
  const [activeAbort, setActiveAbort] = useState<AbortController | null>(null);

  const mountedRef = useRef(true);
  const draftVersionRef = useRef(0);
  const activeAbortRef = useRef<AbortController | null>(null);
  const activeGuardRef = useRef<(() => boolean) | undefined>(undefined);

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

  const models = useSignalValue(aiModelService.models) ?? [];
  const modelStatus = useSignalValue(aiModelService.status) ?? "idle";
  const tools = useSignalValue(aiToolsConfigService.config) ?? {};
  const isReasoningEnabled = !!(
    useSignalValue(reasoningConfig.enabled) ?? false
  );

  const cancelRequest = useCallback((controller: AbortController) => {
    const isOwned = activeAbortRef.current === controller;
    controller.abort();
    if (isOwned) {
      activeAbortRef.current = null;
      setActiveAbort(null);
      activeGuardRef.current = undefined;
    }
    if (
      isOwned ||
      latestRef.current.chatContextValue.abortController === controller
    ) {
      latestRef.current.updateContext({
        abortController: null,
        status: "idle",
      });
    }
  }, []);

  useEffect(() => {
    const running = activeAbortRef.current;
    if (running && !activeGuardRef.current?.()) {
      cancelRequest(running);
    }
  }, [cancelRequest, docId, session?.sessionId, workspaceId]);

  useEffect(() => {
    mountedRef.current = true;
    const expectedVersion = draftVersionRef.current;
    aiDraftService
      ?.getDraft()
      .then((saved) => {
        if (mountedRef.current && expectedVersion === draftVersionRef.current) {
          setDraft(saved.input);
        }
      })
      .catch(console.error);

    return () => {
      mountedRef.current = false;
      previewUrls.dispose();
      draftVersionRef.current += 1;
      activeAbortRef.current?.abort();
      activeAbortRef.current = null;
      activeGuardRef.current = undefined;
    };
  }, [aiDraftService, previewUrls, setDraft]);

  const supportsVision = aiModelService.supportsVision;
  const imageInputUnsupported = useMemo(
    () => conversationHasImages(chatContextValue) && !supportsVision,
    [chatContextValue, supportsVision],
  );

  const generating =
    !!activeAbort ||
    chatContextValue.status === "loading" ||
    chatContextValue.status === "transmitting";

  const sendDisabled =
    generating ||
    !draft.trim() ||
    !!isContextProcessing ||
    imageInputUnsupported;

  const submitPrompt = useCallback(
    async (text: string, clearDraft = false) => {
      const cur = latestRef.current;
      const busy =
        !!activeAbortRef.current ||
        cur.chatContextValue.status === "loading" ||
        cur.chatContextValue.status === "transmitting";
      const blockedByVision =
        conversationHasImages(cur.chatContextValue) &&
        !cur.aiModelService.supportsVision;

      if (
        !mountedRef.current ||
        busy ||
        cur.isContextProcessing ||
        blockedByVision ||
        !text.trim() ||
        !AIProvider.actions.chat
      ) {
        return;
      }

      const snapshotBefore = cur.chatContextValue;
      const savedDraft = draftRef.current;
      const submittedVersion = draftVersionRef.current;
      const initialSessionId = cur.session?.sessionId;
      let ownedSessionId = initialSessionId;
      const targetWorkspaceId = cur.workspaceId;
      const targetDocId = cur.docId;

      const controller = new AbortController();
      const requestId = nanoid();
      const modelId = cur.aiModelService.effectiveModelId;
      const reasoning = cur.aiModelService.reasoningAvailable
        ? !!cur.reasoningConfig.enabled.value
        : undefined;
      const toolsConfig = cur.aiToolsConfigService.config.value;

      activeAbortRef.current = controller;
      setActiveAbort(controller);

      const isCurrent = () =>
        mountedRef.current &&
        activeAbortRef.current === controller &&
        latestRef.current.workspaceId === targetWorkspaceId &&
        latestRef.current.docId === targetDocId &&
        (latestRef.current.session?.sessionId === initialSessionId ||
          latestRef.current.session?.sessionId === ownedSessionId);
      activeGuardRef.current = isCurrent;

      let clearedVersion: number | undefined;
      try {
        const { markdown, images, snapshot, combinedElementsMarkdown, html } =
          snapshotBefore;
        cur.updateContext({
          status: "loading",
          retrievalAvailable: undefined,
          error: null,
          abortController: controller,
        });

        const encodedImages = await Promise.all(
          images.map((image) => readBlobAsURL(image)),
        );
        if (!isCurrent() || controller.signal.aborted) return;

        const sessionId = (await cur.createSession())?.sessionId;
        ownedSessionId = sessionId;
        if (!isCurrent() || controller.signal.aborted) return;
        if (!sessionId) throw new Error("Conversation creation unavailable");

        const contexts = collectChatContexts(
          latestRef.current.chips,
          latestRef.current.docDisplayConfig,
        );
        let workingMessages = snapshotBefore.messages;

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
          docId: targetDocId,
          attachments: images,
          workspaceId: targetWorkspaceId,
          stream: true,
          signal: controller.signal,
          isRootSession: cur.isRootSession,
          where: cur.trackOptions?.where,
          control: cur.trackOptions?.control,
          reasoning,
          toolsConfig,
          modelId,
          onMessageCreated: async () => {
            if (!isCurrent() || controller.signal.aborted) return;
            const userInfo = await AIProvider.userInfo;
            if (!isCurrent() || controller.signal.aborted) return;

            const appended: AIChatInputContext["messages"] = [
              ...snapshotBefore.messages,
              {
                id: "",
                role: "user",
                content: text,
                params: { inputRequestId: requestId },
                createdAt: new Date().toISOString(),
                attachments: encodedImages,
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
            workingMessages = appended;
            const latestCtx = latestRef.current.chatContextValue;
            latestRef.current.updateContext({
              messages: appended,
              images: latestCtx.images.filter((img) => !images.includes(img)),
              quote:
                latestCtx.quote === snapshotBefore.quote ? "" : latestCtx.quote,
              markdown:
                latestCtx.markdown === snapshotBefore.markdown
                  ? ""
                  : latestCtx.markdown,
            });

            if (clearDraft && draftVersionRef.current === submittedVersion) {
              clearedVersion = ++draftVersionRef.current;
              setDraft("");
              await latestRef.current.aiDraftService?.setDraft({ input: "" });
            }
          },
          onRetrievalStatus: (available) => {
            if (isCurrent() && !controller.signal.aborted) {
              latestRef.current.updateContext({
                retrievalAvailable: available,
              });
            }
          },
        });

        for await (const chunk of stream) {
          if (!isCurrent() || controller.signal.aborted) break;
          workingMessages = applyChatStreamChunk(workingMessages, chunk);
          latestRef.current.updateContext({
            messages: workingMessages,
            status: "transmitting",
          });
        }

        if (!isCurrent() || controller.signal.aborted) return;

        if (AIProvider.histories) {
          const histories = await AIProvider.histories.chats(
            targetWorkspaceId,
            sessionId,
          );
          if (!isCurrent()) return;
          const stored = (histories?.[0]?.messages ?? []) as ChatMessage[];
          const userTurn = stored.find(
            (m) => m.role === "user" && m.params?.inputRequestId === requestId,
          );
          const assistantTurn = stored.find(
            (m) =>
              m.role === "assistant" && m.params?.responseTo === userTurn?.id,
          );
          if (!userTurn || !assistantTurn) {
            throw new Error("The response identity could not be reconciled");
          }
          const localUser = workingMessages.at(-2) as ChatMessage;
          const localAssistant = workingMessages.at(-1) as ChatMessage;
          latestRef.current.updateContext({
            messages: [
              ...workingMessages.slice(0, -2),
              { ...localUser, id: userTurn.id, params: userTurn.params },
              {
                ...localAssistant,
                id: assistantTurn.id,
                params: assistantTurn.params,
                generatedFiles: assistantTurn.generatedFiles,
              },
            ],
          });
        }

        if (isCurrent() && !controller.signal.aborted) {
          latestRef.current.onChatSuccess?.();
          latestRef.current.updateContext({ status: "success" });
        }
      } catch (error) {
        if (!isCurrent()) return;
        if (controller.signal.aborted) {
          latestRef.current.updateContext({ status: "idle" });
          return;
        }
        if (
          clearedVersion !== undefined &&
          clearedVersion === draftVersionRef.current
        ) {
          draftVersionRef.current += 1;
          setDraft(savedDraft);
          void latestRef.current.aiDraftService
            ?.setDraft({ input: savedDraft })
            .catch(console.error);
        }
        const latestCtx = latestRef.current.chatContextValue;
        latestRef.current.updateContext({
          status: "error",
          error: error as AIError,
          images: [...new Set([...snapshotBefore.images, ...latestCtx.images])],
          quote: latestCtx.quote || snapshotBefore.quote,
          markdown: latestCtx.markdown || snapshotBefore.markdown,
        });
      } finally {
        if (
          isCurrent() &&
          latestRef.current.chatContextValue.abortController === controller
        ) {
          latestRef.current.updateContext({
            abortController: null,
            ...(controller.signal.aborted ? { status: "idle" } : {}),
          });
        }
        if (activeAbortRef.current === controller) {
          activeAbortRef.current = null;
          setActiveAbort(null);
          activeGuardRef.current = undefined;
        }
      }
    },
    [setDraft],
  );

  useEffect(() => {
    const sub = AIProvider.slots.requestSendWithChat.subscribe(
      (params: AISendParams | null) => {
        if (!params) return;
        const matches = params.host
          ? latestRef.current.host === params.host
          : !latestRef.current.host &&
            (!params.docId || latestRef.current.docId === params.docId);
        if (matches) {
          setTimeout(() => {
            if (!mountedRef.current) return;
            if (params.input) {
              draftVersionRef.current += 1;
              setDraft(params.input);
              void submitPrompt(params.input, false).catch(console.error);
            }
          }, 0);
        }
        AIProvider.slots.requestSendWithChat.next(null);
      },
    );
    return () => sub.unsubscribe();
  }, [setDraft, submitPrompt]);

  const handleInputChange = useCallback(
    (value: string) => {
      if (value === draftRef.current) return;
      draftVersionRef.current += 1;
      setDraft(value);
      void aiDraftService?.setDraft({ input: value }).catch(console.error);
    },
    [aiDraftService, setDraft],
  );

  const handleStop = useCallback(() => {
    const controller =
      activeAbortRef.current ??
      latestRef.current.chatContextValue.abortController;
    if (controller) cancelRequest(controller);
  }, [cancelRequest]);

  const handleRemovePreview = useCallback(
    (file: File) => {
      const currentImages = latestRef.current.chatContextValue.images;
      const idx = currentImages.indexOf(file);
      if (idx === -1) return;
      previewUrls.release(file);
      latestRef.current.updateContext({
        images: currentImages.filter((_, i) => i !== idx),
      });
    },
    [previewUrls],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      event.stopPropagation();
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) addImages([file]);
        }
      }
    },
    [addImages],
  );

  const previews = previewUrls.sync(chatContextValue.images);

  return (
    <Box data-testid={testId}>
      <ChatInputView
        value={draft}
        quote={chatContextValue.quote}
        images={
          previews.length ? (
            <ChatImagePreviewView
              images={previews}
              onRemove={handleRemovePreview}
              onError={previewUrls.release}
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
            reasoning={isReasoningEnabled}
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
        sendDisabled={sendDisabled}
        onInput={handleInputChange}
        onSend={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (sendDisabled) return;
          const text = draftRef.current.trim();
          if (!text) return;
          void submitPrompt(text, true).catch(console.error);
        }}
        onStop={handleStop}
        onPaste={(event) => handlePaste(event.nativeEvent)}
        onRemoveQuote={() => updateContext({ quote: "", markdown: "" })}
      />
    </Box>
  );
}
