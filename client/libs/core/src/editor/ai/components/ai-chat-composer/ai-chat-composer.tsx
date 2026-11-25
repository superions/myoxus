// SPDX-License-Identifier: MIT

import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type {
  ContextEmbedStatus,
  ContextWorkspaceEmbeddingStatus,
  CopilotChatHistoryFragment,
  CopilotContextBlob,
  CopilotContextDoc,
  CopilotContextFile,
} from "@myoxus/graphql";
import {
  Card,
  Dropzone,
  type FileRejection,
  notify,
  Stack,
} from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/editor/std";
import { uuidv4 } from "@virgultum/editor/store";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AIChatParams,
  AIProvider,
  type AISendParams,
} from "../../provider";
import type { SearchMenuConfig } from "../ai-chat-add-context";
import {
  type AttachmentChip,
  type ChatChip,
  type CollectionChip,
  type DocChip,
  type DocDisplayConfig,
  type FileChip,
  findChipIndex,
  isAttachmentChip,
  isCollectionChip,
  isDocChip,
  isFileChip,
  isSelectedContextChip,
  isTagChip,
  omitChip,
  type SelectedContextChip,
  type TagChip,
} from "../ai-chat-chips";
import { ChatPanelChips } from "../ai-chat-chips/chat-panel-chips";
import {
  AIChatInput,
  type AIChatInputContext,
  type AIReasoningConfig,
} from "../ai-chat-input";
import { MAX_IMAGE_COUNT } from "../ai-chat-input/const";
import { chatI18n } from "../chat-i18n";
import { ChatDisclaimer, ChatScrollToLatest } from "../message-chrome";

export const EMBEDDING_STATUS_CHECK_INTERVAL = 10000;
const MAX_CONTEXT_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const COMPOSER_DROPZONE_ACCEPT = {
  "image/*": [],
  "application/pdf": [".pdf"],
  "text/plain": [".txt", ".md"],
  "text/csv": [".csv"],
};

export interface AIChatComposerProps {
  onScrollToLatest?: () => void;
  independentMode?: boolean;
  host?: EditorHost | null;
  workspaceId: string;
  docId?: string;
  session: CopilotChatHistoryFragment | null | undefined;
  createSession: () => Promise<CopilotChatHistoryFragment | null | undefined>;
  chatContextValue: AIChatInputContext;
  updateContext: (context: Partial<AIChatInputContext>) => void;
  onEmbeddingProgressChange?: (
    count: Record<ContextEmbedStatus, number>,
  ) => void;
  docDisplayConfig: DocDisplayConfig;
  reasoningConfig: AIReasoningConfig;
  searchMenuConfig: SearchMenuConfig;
  onChatSuccess?: () => void;
  trackOptions?: VirgultumPresets.TrackerOptions;
  notificationService: NotificationService;
  aiDraftService?: AIDraftService;
  aiToolsConfigService: AIToolsConfigService;
  aiModelService: AIModelService;
  syncedDraft?: string;
  onSyncedDraftChange?: (value: string) => void;
  onRegisterSend?: (send: () => void) => () => void;
  onBroadcastSend?: () => void;
}

export function AIChatComposer({
  onScrollToLatest,
  independentMode,
  host,
  workspaceId,
  docId,
  session,
  createSession,
  chatContextValue,
  updateContext,
  onEmbeddingProgressChange,
  docDisplayConfig,
  reasoningConfig,
  searchMenuConfig,
  onChatSuccess,
  trackOptions,
  notificationService,
  aiDraftService,
  aiToolsConfigService,
  aiModelService,
  syncedDraft,
  onSyncedDraftChange,
  onRegisterSend,
  onBroadcastSend,
}: AIChatComposerProps) {
  const [chips, setChipsState] = useState<ChatChip[]>([]);
  const [isChipsCollapsed, setIsChipsCollapsed] = useState(false);

  const mountedRef = useRef(true);
  const chipsRef = useRef<ChatChip[]>([]);
  const contextIdRef = useRef<string | undefined>(undefined);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollEmbeddingAbortRef = useRef<AbortController | null>(null);
  const prevSessionIdRef = useRef<string | undefined>(undefined);
  const prevStatusRef = useRef(chatContextValue.status);

  const latestRef = useRef({
    host,
    workspaceId,
    docId,
    session,
    createSession,
    chatContextValue,
    updateContext,
    onEmbeddingProgressChange,
    docDisplayConfig,
    notificationService,
  });
  latestRef.current = {
    host,
    workspaceId,
    docId,
    session,
    createSession,
    chatContextValue,
    updateContext,
    onEmbeddingProgressChange,
    docDisplayConfig,
    notificationService,
  };

  const setChips = useCallback((next: ChatChip[]) => {
    chipsRef.current = next;
    setChipsState(next);
  }, []);

  const abortPoll = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  }, []);

  const abortPollEmbeddingStatus = useCallback(() => {
    pollEmbeddingAbortRef.current?.abort();
    pollEmbeddingAbortRef.current = null;
  }, []);

  const getContextId = useCallback(async () => {
    if (contextIdRef.current) return contextIdRef.current;
    const sessionId = latestRef.current.session?.sessionId;
    if (!sessionId) return;
    const contextId = await AIProvider.context?.getContextId(
      latestRef.current.workspaceId,
      sessionId,
    );
    if (latestRef.current.session?.sessionId !== sessionId) return;
    contextIdRef.current = contextId;
    return contextId;
  }, []);

  const createContextId = useCallback(async () => {
    if (contextIdRef.current) return contextIdRef.current;
    const sessionId = (await latestRef.current.createSession())?.sessionId;
    if (!sessionId) return;
    const contextId = await AIProvider.context?.createContext(
      latestRef.current.workspaceId,
      sessionId,
    );
    if (latestRef.current.session?.sessionId !== sessionId) return;
    contextIdRef.current = contextId;
    return contextId;
  }, []);

  const updateChip = useCallback(
    (chip: ChatChip, options: Partial<DocChip | FileChip>) => {
      const current = chipsRef.current;
      const index = findChipIndex(current, chip);
      if (index === -1) return;
      const nextChip: ChatChip = { ...chip, ...options };
      setChips([
        ...current.slice(0, index),
        nextChip,
        ...current.slice(index + 1),
      ]);
    },
    [setChips],
  );

  const onPoll = useCallback(
    (result?: VirgultumPresets.AIDocsAndFilesContext) => {
      if (!result) {
        abortPoll();
        setChips(
          chipsRef.current.map((chip) =>
            chip.state === "processing"
              ? {
                  ...chip,
                  state: "failed",
                  tooltip:
                    chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
                }
              : chip,
          ),
        );
        return;
      }
      const {
        docs: sDocs = [],
        files = [],
        tags = [],
        collections = [],
        blobs = [],
      } = result;
      const docs = [
        ...sDocs,
        ...tags.flatMap((tag) => tag.docs),
        ...collections.flatMap((collection) => collection.docs),
      ];
      const hashMap = new Map<
        string,
        CopilotContextDoc | CopilotContextFile | CopilotContextBlob
      >();
      const count: Record<ContextEmbedStatus, number> = {
        finished: 0,
        processing: 0,
        failed: 0,
      };
      docs.forEach((doc) => {
        hashMap.set(doc.id, doc);
        doc.status && count[doc.status]++;
      });
      files.forEach((file) => {
        hashMap.set(file.id, file);
        file.status && count[file.status]++;
      });
      blobs.forEach((blob) => {
        hashMap.set(blob.id, blob);
        blob.status && count[blob.status]++;
      });
      const nextChips = chipsRef.current.map((chip) => {
        if (isTagChip(chip) || isCollectionChip(chip)) return chip;
        const id = isDocChip(chip)
          ? chip.docId
          : isFileChip(chip)
            ? chip.fileId
            : isAttachmentChip(chip)
              ? chip.sourceId
              : isSelectedContextChip(chip)
                ? chip.uuid
                : undefined;
        const item = id && hashMap.get(id);
        if (item && item.status) {
          return {
            ...chip,
            state: item.status,
            tooltip: "error" in item ? item.error : undefined,
          };
        }
        if (id && chip.state === "processing") {
          return {
            ...chip,
            state: "failed" as const,
            tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
          };
        }
        return chip;
      });
      setChips(nextChips);
      latestRef.current.onEmbeddingProgressChange?.(count);
      if (count.processing === 0) abortPoll();
    },
    [abortPoll, setChips],
  );

  const pollContextDocsAndFiles = useCallback(async () => {
    const sessionId = latestRef.current.session?.sessionId;
    const contextId = await getContextId();
    if (!sessionId || !contextId || !AIProvider.context) return;
    if (pollAbortRef.current) abortPoll();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      await AIProvider.context.pollContextDocsAndFiles(
        latestRef.current.workspaceId,
        sessionId,
        contextId,
        (result) => {
          if (
            !controller.signal.aborted &&
            mountedRef.current &&
            latestRef.current.session?.sessionId === sessionId &&
            contextIdRef.current === contextId
          ) {
            onPoll(result);
          }
        },
        controller.signal,
      );
    } catch {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        latestRef.current.session?.sessionId !== sessionId ||
        contextIdRef.current !== contextId
      )
        return;
      setChips(
        chipsRef.current.map((chip) =>
          chip.state === "processing"
            ? {
                ...chip,
                state: "failed",
                tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
              }
            : chip,
        ),
      );
      abortPoll();
    }
  }, [abortPoll, getContextId, onPoll, setChips]);

  const pollEmbeddingStatus = useCallback(async () => {
    abortPollEmbeddingStatus();
    const controller = new AbortController();
    pollEmbeddingAbortRef.current = controller;
    try {
      await AIProvider.context?.pollEmbeddingStatus(
        latestRef.current.workspaceId,
        (status: ContextWorkspaceEmbeddingStatus) => {
          if (controller.signal.aborted || !status) return;
          if (!status.available) {
            latestRef.current.updateContext({ retrievalAvailable: false });
          }
        },
        controller.signal,
      );
    } catch {
      // Ignore transient polling failures.
    }
  }, [abortPollEmbeddingStatus]);

  const addFileToContext = useCallback(
    async (chip: FileChip) => {
      let sessionId = latestRef.current.session?.sessionId;
      try {
        const contextId = await createContextId();
        if (!contextId || !AIProvider.context)
          throw new Error("Context not found");
        sessionId = latestRef.current.session?.sessionId;
        const contextFile = await AIProvider.context.addContextFile(chip.file, {
          contextId,
        });
        if (latestRef.current.session?.sessionId !== sessionId) return;
        if (findChipIndex(chipsRef.current, chip) === -1) {
          await AIProvider.context.removeContextFile({
            contextId,
            fileId: contextFile.id,
          });
          return;
        }
        if (!mountedRef.current || contextIdRef.current !== contextId) return;
        updateChip(chip, {
          state: contextFile.status,
          blobId: contextFile.blobId,
          fileId: contextFile.id,
        });
      } catch {
        if (
          !mountedRef.current ||
          latestRef.current.session?.sessionId !== sessionId
        )
          return;
        if (findChipIndex(chipsRef.current, chip) === -1) {
          latestRef.current.notificationService.toast(
            chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
          );
          return;
        }
        updateChip(chip, {
          state: "failed",
          tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
        });
      }
    },
    [createContextId, updateChip],
  );

  const addAttachmentChipToContext = useCallback(
    async (chip: AttachmentChip) => {
      let sessionId = latestRef.current.session?.sessionId;
      try {
        const contextId = await createContextId();
        if (!contextId || !AIProvider.context)
          throw new Error("Context not found");
        sessionId = latestRef.current.session?.sessionId;
        const contextBlob = await AIProvider.context.addContextBlob({
          blobId: chip.sourceId,
          contextId,
        });
        if (latestRef.current.session?.sessionId !== sessionId) return;
        if (findChipIndex(chipsRef.current, chip) === -1) {
          await AIProvider.context.removeContextBlob({
            contextId,
            blobId: chip.sourceId,
          });
          return;
        }
        if (!mountedRef.current || contextIdRef.current !== contextId) return;
        updateChip(chip, {
          state: contextBlob.status || "processing",
          blobId: chip.sourceId,
        });
      } catch {
        if (
          !mountedRef.current ||
          latestRef.current.session?.sessionId !== sessionId
        )
          return;
        if (findChipIndex(chipsRef.current, chip) === -1) {
          latestRef.current.notificationService.toast(
            chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
          );
          return;
        }
        updateChip(chip, {
          state: "failed",
          tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
        });
      }
    },
    [createContextId, updateChip],
  );

  const addToContext = useCallback(
    async (chip: ChatChip) => {
      if (isDocChip(chip)) {
        try {
          const contextId = await createContextId();
          if (!contextId || !AIProvider.context)
            throw new Error("Context not found");
          await AIProvider.context.addContextDoc({
            contextId,
            docId: chip.docId,
          });
        } catch {
          updateChip(chip, {
            state: "failed",
            tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
          });
        }
        return;
      }
      if (isFileChip(chip)) return await addFileToContext(chip);
      if (isTagChip(chip)) {
        try {
          const contextId = await createContextId();
          if (!contextId || !AIProvider.context)
            throw new Error("Context not found");
          const docIds = latestRef.current.docDisplayConfig.getTagPageIds(
            chip.tagId,
          );
          await AIProvider.context.addContextTag({
            contextId,
            tagId: chip.tagId,
            docIds,
          });
          updateChip(chip, { state: "finished" });
        } catch {
          updateChip(chip, {
            state: "failed",
            tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
          });
        }
        return;
      }
      if (isCollectionChip(chip)) {
        try {
          const contextId = await createContextId();
          if (!contextId || !AIProvider.context)
            throw new Error("Context not found");
          const docIds =
            latestRef.current.docDisplayConfig.getCollectionPageIds(
              chip.collectionId,
            );
          await AIProvider.context.addContextCollection({
            contextId,
            collectionId: chip.collectionId,
            docIds,
          });
          updateChip(chip, { state: "finished" });
        } catch {
          updateChip(chip, {
            state: "failed",
            tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
          });
        }
        return;
      }
      if (isAttachmentChip(chip)) return await addAttachmentChipToContext(chip);
    },
    [addAttachmentChipToContext, addFileToContext, createContextId, updateChip],
  );

  const removeFromContext = useCallback(
    async (chip: ChatChip): Promise<boolean> => {
      try {
        const contextId = await createContextId();
        if (!contextId || !AIProvider.context) return true;
        if (isDocChip(chip)) {
          return await AIProvider.context.removeContextDoc({
            contextId,
            docId: chip.docId,
          });
        }
        if (isFileChip(chip) && chip.fileId) {
          return await AIProvider.context.removeContextFile({
            contextId,
            fileId: chip.fileId,
          });
        }
        if (isTagChip(chip)) {
          return await AIProvider.context.removeContextTag({
            contextId,
            tagId: chip.tagId,
          });
        }
        if (isCollectionChip(chip)) {
          return await AIProvider.context.removeContextCollection({
            contextId,
            collectionId: chip.collectionId,
          });
        }
        if (isAttachmentChip(chip)) {
          return await AIProvider.context.removeContextBlob({
            contextId,
            blobId: chip.sourceId,
          });
        }
        if (isSelectedContextChip(chip)) {
          latestRef.current.updateContext({
            ...latestRef.current.chatContextValue,
            snapshot: null,
            combinedElementsMarkdown: null,
          });
        }
        return true;
      } catch {
        return false;
      }
    },
    [createContextId],
  );

  const addChip = useCallback(
    async (chip: ChatChip, silent = false) => {
      setIsChipsCollapsed(false);
      const current = chipsRef.current;
      if (findChipIndex(current, chip) !== -1) {
        if (!silent) {
          latestRef.current.notificationService.toast(
            chatI18n()["com.myoxus.ai.chat-panel.context-already-added"](),
          );
        }
        return;
      }
      setChips([...current, chip]);
      await addToContext(chip);
      await pollContextDocsAndFiles();
    },
    [addToContext, pollContextDocsAndFiles, setChips],
  );

  const removeChip = useCallback(
    async (chip: ChatChip) => {
      const sessionId = latestRef.current.session?.sessionId;
      if (!(await removeFromContext(chip)))
        throw new Error("Context removal was not acknowledged");
      if (
        mountedRef.current &&
        latestRef.current.session?.sessionId === sessionId
      ) {
        setChips(omitChip(chipsRef.current, chip));
      }
    },
    [removeFromContext, setChips],
  );

  const retryFileChip = useCallback(
    async (chip: FileChip) => {
      const current = chipsRef.current;
      if (
        current[findChipIndex(current, chip)]?.state !== "failed" ||
        !AIProvider.context
      )
        return;
      updateChip(chip, { state: "processing", tooltip: undefined });
      const sessionId = latestRef.current.session?.sessionId;
      let contextId: string | undefined;
      try {
        contextId = await getContextId();
      } catch {
        if (
          mountedRef.current &&
          latestRef.current.session?.sessionId === sessionId
        ) {
          updateChip(chip, {
            state: "failed",
            tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
          });
        }
        return;
      }
      if (
        !mountedRef.current ||
        latestRef.current.session?.sessionId !== sessionId
      )
        return;
      if (!contextId || !sessionId) {
        updateChip(chip, { state: "failed" });
        return;
      }
      if (!chip.fileId) {
        await addFileToContext(chip);
      } else {
        try {
          const file = await AIProvider.context.retryContextFile({
            contextId,
            fileId: chip.fileId,
          });
          if (
            !mountedRef.current ||
            contextIdRef.current !== contextId ||
            latestRef.current.session?.sessionId !== sessionId
          )
            return;
          updateChip(chip, { state: file.status, tooltip: file.error });
        } catch {
          if (
            mountedRef.current &&
            contextIdRef.current === contextId &&
            latestRef.current.session?.sessionId === sessionId
          ) {
            updateChip(chip, {
              state: "failed",
              tooltip: chatI18n()["com.myoxus.ai.chat-panel.context-error"](),
            });
          }
        }
      }
      if (
        mountedRef.current &&
        contextIdRef.current === contextId &&
        latestRef.current.session?.sessionId === sessionId
      ) {
        await pollContextDocsAndFiles();
      }
    },
    [addFileToContext, getContextId, pollContextDocsAndFiles, updateChip],
  );

  const retryAttachmentChip = useCallback(
    async (chip: AttachmentChip) => {
      const current = chipsRef.current;
      if (current[findChipIndex(current, chip)]?.state !== "failed") return;
      const sessionId = latestRef.current.session?.sessionId;
      const contextId = contextIdRef.current;
      updateChip(chip, { state: "processing", tooltip: undefined });
      await addAttachmentChipToContext(chip);
      if (
        mountedRef.current &&
        latestRef.current.session?.sessionId === sessionId &&
        contextIdRef.current === contextId
      ) {
        await pollContextDocsAndFiles();
      }
    },
    [addAttachmentChipToContext, pollContextDocsAndFiles, updateChip],
  );

  const initChips = useCallback(async () => {
    const sessionId = latestRef.current.session?.sessionId;
    const contextId = await getContextId();
    if (!sessionId || !contextId) return;
    const {
      docs = [],
      files = [],
      tags = [],
      collections = [],
      blobs = [],
    } = (await AIProvider.context?.getContextDocsAndFiles(
      latestRef.current.workspaceId,
      sessionId,
      contextId,
    )) || {};
    if (
      !mountedRef.current ||
      latestRef.current.session?.sessionId !== sessionId ||
      contextIdRef.current !== contextId
    )
      return;

    const docChips: DocChip[] = docs.map((doc) => ({
      docId: doc.id,
      state: doc.status || "processing",
      createdAt: doc.createdAt,
    }));
    const fileChips: FileChip[] = files.map((file) => ({
      file: new File([], file.name, { type: file.mimeType }),
      blobId: file.blobId,
      fileId: file.id,
      state: file.status,
      tooltip: file.error,
      createdAt: file.createdAt,
    }));
    const tagChips: TagChip[] = tags.map((tag) => ({
      tagId: tag.id,
      state: "finished",
      createdAt: tag.createdAt,
    }));
    const collectionChips: CollectionChip[] = collections.map((collection) => ({
      collectionId: collection.id,
      state: "finished",
      createdAt: collection.createdAt,
    }));

    const loaded: ChatChip[] = [
      ...docChips,
      ...fileChips,
      ...tagChips,
      ...collectionChips,
      ...blobs.map(
        (blob) =>
          ({
            sourceId: blob.id,
            name: blob.id,
            state: blob.status ?? "failed",
            createdAt: blob.createdAt,
          }) as AttachmentChip,
      ),
    ].sort((a, b) => (a.createdAt ?? Date.now()) - (b.createdAt ?? Date.now()));
    setChips(loaded);
  }, [getContextId, setChips]);

  const initComposer = useCallback(async () => {
    const userId = (await AIProvider.userInfo)?.id;
    if (!userId || !latestRef.current.session) return;
    await initChips();
    const needPoll = chipsRef.current.some(
      (chip) =>
        chip.state === "processing" ||
        isTagChip(chip) ||
        isCollectionChip(chip),
    );
    if (needPoll) await pollContextDocsAndFiles();
    await pollEmbeddingStatus();
  }, [initChips, pollContextDocsAndFiles, pollEmbeddingStatus]);

  useEffect(() => {
    mountedRef.current = true;
    const beforeChatContextSend = (
      params: AISendParams | AIChatParams | null,
    ) => {
      if (!params) return;
      const { context, host: targetHost, docId: targetDocId } = params;
      const matchesTarget = targetHost
        ? latestRef.current.host === targetHost
        : !latestRef.current.host &&
          (!targetDocId || latestRef.current.docId === targetDocId);
      if (!matchesTarget || !context) return;
      latestRef.current.updateContext(context);
      if (
        context.docs ||
        context.attachments ||
        context.snapshot ||
        context.combinedElementsMarkdown ||
        context.html
      ) {
        setTimeout(() => {
          void (async () => {
            const existing = chipsRef.current.find((c) =>
              isSelectedContextChip(c),
            );
            if (existing) await removeChip(existing);
            const ctx = latestRef.current.chatContextValue;
            const chip: SelectedContextChip = {
              uuid: uuidv4(),
              snapshot: ctx.snapshot ?? null,
              combinedElementsMarkdown: ctx.combinedElementsMarkdown ?? null,
              html: ctx.html ?? null,
              state: "finished",
            };
            await Promise.all([
              addChip(chip, true),
              ...(ctx.docs ?? []).map((id) =>
                addChip({ docId: id, state: "processing" }, true),
              ),
              ...(ctx.attachments ?? []).map((att) =>
                addChip(
                  {
                    sourceId: att.sourceId,
                    name: att.name,
                    state: "processing",
                  },
                  true,
                ),
              ),
            ]);
          })().catch(console.error);
        }, 0);
      }
    };
    const openSub = AIProvider.slots.requestOpenWithChat.subscribe(
      beforeChatContextSend,
    );
    const sendSub = AIProvider.slots.requestSendWithChat.subscribe(
      beforeChatContextSend,
    );
    return () => {
      mountedRef.current = false;
      openSub.unsubscribe();
      sendSub.unsubscribe();
      abortPoll();
      abortPollEmbeddingStatus();
    };
  }, [abortPoll, abortPollEmbeddingStatus, addChip, removeChip]);

  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    const nextId = session?.sessionId;
    if (prevId && prevId !== nextId) {
      abortPoll();
      abortPollEmbeddingStatus();
      contextIdRef.current = undefined;
      setChips([]);
    }
    prevSessionIdRef.current = nextId;
    if (nextId && (!contextIdRef.current || prevId !== nextId)) {
      void initComposer().catch(console.error);
    }
  }, [
    abortPoll,
    abortPollEmbeddingStatus,
    initComposer,
    session?.sessionId,
    setChips,
  ]);

  useEffect(() => {
    if (
      prevStatusRef.current !== "loading" &&
      chatContextValue.status === "loading"
    ) {
      setIsChipsCollapsed(true);
    }
    prevStatusRef.current = chatContextValue.status;
  }, [chatContextValue.status]);

  const addImages = useCallback((images: File[]) => {
    const oldImages = latestRef.current.chatContextValue.images;
    if (oldImages.length + images.length > MAX_IMAGE_COUNT) {
      latestRef.current.notificationService.toast(
        chatI18n()["com.myoxus.ai.chat-panel.image-count-limit"]({
          count: String(MAX_IMAGE_COUNT),
        }),
      );
    }
    latestRef.current.updateContext({
      images: [...oldImages, ...images].slice(0, MAX_IMAGE_COUNT),
    });
  }, []);

  const isContextProcessing = chips.some((chip) => chip.state === "processing");
  const isDropDisabled =
    chatContextValue.status === "loading" ||
    chatContextValue.status === "transmitting";

  const handleDropFiles = useCallback(
    (files: File[]) => {
      if (isDropDisabled) return;
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length) addImages(images);
      const docs = files.filter((file) => !file.type.startsWith("image/"));
      void Promise.all(
        docs.map(async (file) => {
          if (file.size > MAX_CONTEXT_FILE_SIZE_BYTES) {
            notify({
              title: chatI18n()["com.myoxus.ai.chat-panel.file-too-large"]({
                name: file.name,
              }),
            });
            return;
          }
          await addChip({ file, state: "processing" });
        }),
      );
    },
    [addChip, addImages, isDropDisabled],
  );

  const handleRejectFiles = useCallback(
    (rejections: FileRejection[]) => {
      if (isDropDisabled) return;
      for (const rejection of rejections) {
        if (rejection.file.size > MAX_CONTEXT_FILE_SIZE_BYTES) {
          notify({
            title: chatI18n()["com.myoxus.ai.chat-panel.file-too-large"]({
              name: rejection.file.name,
            }),
          });
        } else {
          notify({
            title: chatI18n()["com.myoxus.common.operation-failed"](),
            message: rejection.file.name,
          });
        }
      }
    },
    [isDropDisabled],
  );

  return (
    <Stack gap="xs" style={{ flexShrink: 0 }}>
      {onScrollToLatest ? (
        <ChatScrollToLatest onClick={onScrollToLatest} />
      ) : null}
      <Card withBorder padding="sm" data-myoxus-ui-role="chat-composer">
        <Dropzone
          activateOnClick={false}
          activateOnKeyboard={false}
          enablePointerEvents
          accept={COMPOSER_DROPZONE_ACCEPT}
          maxSize={MAX_CONTEXT_FILE_SIZE_BYTES}
          onDrop={handleDropFiles}
          onReject={handleRejectFiles}
          p={0}
          style={{ borderColor: "transparent", background: "transparent" }}
        >
          <Stack gap="xs">
            <ChatPanelChips
              chips={chips}
              isCollapsed={isChipsCollapsed}
              independentMode={independentMode}
              addChip={addChip}
              updateChip={updateChip}
              removeChip={removeChip}
              retryFileChip={retryFileChip}
              retryAttachmentChip={retryAttachmentChip}
              toggleCollapse={() => setIsChipsCollapsed((prev) => !prev)}
              docDisplayConfig={docDisplayConfig}
            />
            <AIChatInput
              independentMode={independentMode}
              host={host}
              workspaceId={workspaceId}
              docId={docId}
              session={session}
              chips={chips}
              addChip={addChip}
              addImages={addImages}
              createSession={createSession}
              chatContextValue={chatContextValue}
              updateContext={updateContext}
              reasoningConfig={reasoningConfig}
              docDisplayConfig={docDisplayConfig}
              searchMenuConfig={searchMenuConfig}
              aiDraftService={aiDraftService}
              aiToolsConfigService={aiToolsConfigService}
              aiModelService={aiModelService}
              onChatSuccess={onChatSuccess}
              trackOptions={trackOptions}
              isContextProcessing={isContextProcessing}
              syncedDraft={syncedDraft}
              onSyncedDraftChange={onSyncedDraftChange}
              onRegisterSend={onRegisterSend}
              onBroadcastSend={onBroadcastSend}
            />
          </Stack>
        </Dropzone>
      </Card>
      <ChatDisclaimer>
        {chatI18n()["com.myoxus.ai.chat-panel.disclaimer"]()}
      </ChatDisclaimer>
    </Stack>
  );
}
