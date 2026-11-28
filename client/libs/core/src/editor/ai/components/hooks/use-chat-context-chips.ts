// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  ContextEmbedStatus,
  ContextWorkspaceEmbeddingStatus,
  CopilotChatHistoryFragment,
  CopilotContextBlob,
  CopilotContextDoc,
  CopilotContextFile,
} from "@myoxus/graphql";
import type { NotificationService } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/editor/std";
import { uuidv4 } from "@virgultum/editor/store";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type AIChatParams,
  AIProvider,
  type AISendParams,
} from "../../provider";
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
import type { AIChatInputContext } from "../ai-chat-input/type";
import { MAX_IMAGE_COUNT } from "../ai-chat-input/const";
import { chatI18n } from "../chat-i18n";

export interface UseChatContextChipsOptions {
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
  notificationService: NotificationService;
}

/**
 * Manages chat context chips (documents, uploaded files, tags, collections,
 * attachments, and canvas selection snapshots) plus server context polling.
 */
export function useChatContextChips(options: UseChatContextChipsOptions) {
  const [chips, setChipsState] = useState<ChatChip[]>([]);
  const [isChipsCollapsed, setIsChipsCollapsed] = useState(false);

  const mountedRef = useRef(true);
  const chipsRef = useRef<ChatChip[]>([]);
  const contextIdRef = useRef<string | undefined>(undefined);
  const pollAbortRef = useRef<AbortController | null>(null);
  const embeddingAbortRef = useRef<AbortController | null>(null);
  const prevSessionIdRef = useRef<string | undefined>(undefined);
  const prevStatusRef = useRef(options.chatContextValue.status);

  const latestRef = useRef(options);
  latestRef.current = options;

  const setChips = useCallback((next: ChatChip[]) => {
    chipsRef.current = next;
    setChipsState(next);
  }, []);

  const stopPolling = useCallback(() => {
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
  }, []);

  const stopEmbeddingPolling = useCallback(() => {
    embeddingAbortRef.current?.abort();
    embeddingAbortRef.current = null;
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

  const ensureContextId = useCallback(async () => {
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
    (target: ChatChip, patch: Partial<DocChip | FileChip>) => {
      const current = chipsRef.current;
      const idx = findChipIndex(current, target);
      if (idx === -1) return;
      const updated: ChatChip = { ...target, ...patch };
      setChips([...current.slice(0, idx), updated, ...current.slice(idx + 1)]);
    },
    [setChips],
  );

  const failProcessingChips = useCallback(() => {
    const errorTooltip = chatI18n()["com.myoxus.ai.chat-panel.context-error"]();
    setChips(
      chipsRef.current.map((chip) =>
        chip.state === "processing"
          ? { ...chip, state: "failed", tooltip: errorTooltip }
          : chip,
      ),
    );
  }, [setChips]);

  const applyPollResult = useCallback(
    (result?: VirgultumPresets.AIDocsAndFilesContext) => {
      if (!result) {
        stopPolling();
        failProcessingChips();
        return;
      }

      const {
        docs: directDocs = [],
        files = [],
        tags = [],
        collections = [],
        blobs = [],
      } = result;
      const allDocs = [
        ...directDocs,
        ...tags.flatMap((t) => t.docs),
        ...collections.flatMap((c) => c.docs),
      ];

      const statusById = new Map<
        string,
        CopilotContextDoc | CopilotContextFile | CopilotContextBlob
      >();
      const counts: Record<ContextEmbedStatus, number> = {
        finished: 0,
        processing: 0,
        failed: 0,
      };

      for (const item of [...allDocs, ...files, ...blobs]) {
        statusById.set(item.id, item);
        if (item.status) counts[item.status] += 1;
      }

      const errorTooltip =
        chatI18n()["com.myoxus.ai.chat-panel.context-error"]();
      const next = chipsRef.current.map((chip) => {
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
        const entry = id ? statusById.get(id) : undefined;
        if (entry?.status) {
          return {
            ...chip,
            state: entry.status,
            tooltip: "error" in entry ? entry.error : undefined,
          };
        }
        if (id && chip.state === "processing") {
          return { ...chip, state: "failed" as const, tooltip: errorTooltip };
        }
        return chip;
      });

      setChips(next);
      latestRef.current.onEmbeddingProgressChange?.(counts);
      if (counts.processing === 0) stopPolling();
    },
    [failProcessingChips, setChips, stopPolling],
  );

  const pollContextDocsAndFiles = useCallback(async () => {
    const sessionId = latestRef.current.session?.sessionId;
    const contextId = await getContextId();
    if (!sessionId || !contextId || !AIProvider.context) return;

    stopPolling();
    const controller = new AbortController();
    pollAbortRef.current = controller;

    const isStillValid = () =>
      !controller.signal.aborted &&
      mountedRef.current &&
      latestRef.current.session?.sessionId === sessionId &&
      contextIdRef.current === contextId;

    try {
      await AIProvider.context.pollContextDocsAndFiles(
        latestRef.current.workspaceId,
        sessionId,
        contextId,
        (result) => {
          if (isStillValid()) applyPollResult(result);
        },
        controller.signal,
      );
    } catch {
      if (!isStillValid()) return;
      failProcessingChips();
      stopPolling();
    }
  }, [applyPollResult, failProcessingChips, getContextId, stopPolling]);

  const pollEmbeddingStatus = useCallback(async () => {
    stopEmbeddingPolling();
    const controller = new AbortController();
    embeddingAbortRef.current = controller;
    try {
      await AIProvider.context?.pollEmbeddingStatus(
        latestRef.current.workspaceId,
        (status: ContextWorkspaceEmbeddingStatus) => {
          if (!controller.signal.aborted && status && !status.available) {
            latestRef.current.updateContext({ retrievalAvailable: false });
          }
        },
        controller.signal,
      );
    } catch {
      // Transient embedding status poll errors are non-fatal.
    }
  }, [stopEmbeddingPolling]);

  const uploadFileChip = useCallback(
    async (chip: FileChip) => {
      let sessionId = latestRef.current.session?.sessionId;
      try {
        const contextId = await ensureContextId();
        if (!contextId || !AIProvider.context) {
          throw new Error("Context not found");
        }
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
        ) {
          return;
        }
        const errorTooltip =
          chatI18n()["com.myoxus.ai.chat-panel.context-error"]();
        if (findChipIndex(chipsRef.current, chip) === -1) {
          latestRef.current.notificationService.toast(errorTooltip);
          return;
        }
        updateChip(chip, { state: "failed", tooltip: errorTooltip });
      }
    },
    [ensureContextId, updateChip],
  );

  const uploadAttachmentChip = useCallback(
    async (chip: AttachmentChip) => {
      let sessionId = latestRef.current.session?.sessionId;
      try {
        const contextId = await ensureContextId();
        if (!contextId || !AIProvider.context) {
          throw new Error("Context not found");
        }
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
        ) {
          return;
        }
        const errorTooltip =
          chatI18n()["com.myoxus.ai.chat-panel.context-error"]();
        if (findChipIndex(chipsRef.current, chip) === -1) {
          latestRef.current.notificationService.toast(errorTooltip);
          return;
        }
        updateChip(chip, { state: "failed", tooltip: errorTooltip });
      }
    },
    [ensureContextId, updateChip],
  );

  const syncChipToServer = useCallback(
    async (chip: ChatChip) => {
      if (isFileChip(chip)) return uploadFileChip(chip);
      if (isAttachmentChip(chip)) return uploadAttachmentChip(chip);

      const errorTooltip =
        chatI18n()["com.myoxus.ai.chat-panel.context-error"]();
      if (isDocChip(chip)) {
        try {
          const contextId = await ensureContextId();
          if (!contextId || !AIProvider.context) {
            throw new Error("Context not found");
          }
          await AIProvider.context.addContextDoc({
            contextId,
            docId: chip.docId,
          });
        } catch {
          updateChip(chip, { state: "failed", tooltip: errorTooltip });
        }
        return;
      }

      if (isTagChip(chip)) {
        try {
          const contextId = await ensureContextId();
          if (!contextId || !AIProvider.context) {
            throw new Error("Context not found");
          }
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
          updateChip(chip, { state: "failed", tooltip: errorTooltip });
        }
        return;
      }

      if (isCollectionChip(chip)) {
        try {
          const contextId = await ensureContextId();
          if (!contextId || !AIProvider.context) {
            throw new Error("Context not found");
          }
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
          updateChip(chip, { state: "failed", tooltip: errorTooltip });
        }
      }
    },
    [ensureContextId, updateChip, uploadAttachmentChip, uploadFileChip],
  );

  const removeFromServer = useCallback(
    async (chip: ChatChip): Promise<boolean> => {
      try {
        const contextId = await ensureContextId();
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
    [ensureContextId],
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
      await syncChipToServer(chip);
      await pollContextDocsAndFiles();
    },
    [pollContextDocsAndFiles, setChips, syncChipToServer],
  );

  const removeChip = useCallback(
    async (chip: ChatChip) => {
      const sessionId = latestRef.current.session?.sessionId;
      if (!(await removeFromServer(chip))) {
        throw new Error("Context removal was not acknowledged");
      }
      if (
        mountedRef.current &&
        latestRef.current.session?.sessionId === sessionId
      ) {
        setChips(omitChip(chipsRef.current, chip));
      }
    },
    [removeFromServer, setChips],
  );

  const retryFileChip = useCallback(
    async (chip: FileChip) => {
      const current = chipsRef.current;
      if (
        current[findChipIndex(current, chip)]?.state !== "failed" ||
        !AIProvider.context
      ) {
        return;
      }
      updateChip(chip, { state: "processing", tooltip: undefined });
      const sessionId = latestRef.current.session?.sessionId;
      const errorTooltip =
        chatI18n()["com.myoxus.ai.chat-panel.context-error"]();

      let contextId: string | undefined;
      try {
        contextId = await getContextId();
      } catch {
        if (
          mountedRef.current &&
          latestRef.current.session?.sessionId === sessionId
        ) {
          updateChip(chip, { state: "failed", tooltip: errorTooltip });
        }
        return;
      }
      if (
        !mountedRef.current ||
        latestRef.current.session?.sessionId !== sessionId
      ) {
        return;
      }
      if (!contextId || !sessionId) {
        updateChip(chip, { state: "failed" });
        return;
      }

      if (!chip.fileId) {
        await uploadFileChip(chip);
      } else {
        try {
          const retried = await AIProvider.context.retryContextFile({
            contextId,
            fileId: chip.fileId,
          });
          if (
            !mountedRef.current ||
            contextIdRef.current !== contextId ||
            latestRef.current.session?.sessionId !== sessionId
          ) {
            return;
          }
          updateChip(chip, { state: retried.status, tooltip: retried.error });
        } catch {
          if (
            mountedRef.current &&
            contextIdRef.current === contextId &&
            latestRef.current.session?.sessionId === sessionId
          ) {
            updateChip(chip, { state: "failed", tooltip: errorTooltip });
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
    [getContextId, pollContextDocsAndFiles, updateChip, uploadFileChip],
  );

  const retryAttachmentChip = useCallback(
    async (chip: AttachmentChip) => {
      if (
        chipsRef.current[findChipIndex(chipsRef.current, chip)]?.state !==
        "failed"
      ) {
        return;
      }
      const sessionId = latestRef.current.session?.sessionId;
      const contextId = contextIdRef.current;
      updateChip(chip, { state: "processing", tooltip: undefined });
      await uploadAttachmentChip(chip);
      if (
        mountedRef.current &&
        latestRef.current.session?.sessionId === sessionId &&
        contextIdRef.current === contextId
      ) {
        await pollContextDocsAndFiles();
      }
    },
    [pollContextDocsAndFiles, updateChip, uploadAttachmentChip],
  );

  const loadSessionChips = useCallback(async () => {
    const userId = (await AIProvider.userInfo)?.id;
    const sessionId = latestRef.current.session?.sessionId;
    if (!userId || !sessionId) return;

    const contextId = await getContextId();
    if (!contextId) return;

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
    )) ?? {};

    if (
      !mountedRef.current ||
      latestRef.current.session?.sessionId !== sessionId ||
      contextIdRef.current !== contextId
    ) {
      return;
    }

    const loaded: ChatChip[] = [
      ...docs.map((doc): DocChip => ({
        docId: doc.id,
        state: doc.status || "processing",
        createdAt: doc.createdAt,
      })),
      ...files.map((file): FileChip => ({
        file: new File([], file.name, { type: file.mimeType }),
        blobId: file.blobId,
        fileId: file.id,
        state: file.status,
        tooltip: file.error,
        createdAt: file.createdAt,
      })),
      ...tags.map((tag): TagChip => ({
        tagId: tag.id,
        state: "finished",
        createdAt: tag.createdAt,
      })),
      ...collections.map((col): CollectionChip => ({
        collectionId: col.id,
        state: "finished",
        createdAt: col.createdAt,
      })),
      ...blobs.map((blob): AttachmentChip => ({
        sourceId: blob.id,
        name: blob.id,
        state: blob.status ?? "failed",
        createdAt: blob.createdAt,
      })),
    ].sort((a, b) => (a.createdAt ?? Date.now()) - (b.createdAt ?? Date.now()));

    setChips(loaded);

    const needsPoll = loaded.some(
      (chip) =>
        chip.state === "processing" ||
        isTagChip(chip) ||
        isCollectionChip(chip),
    );
    if (needsPoll) await pollContextDocsAndFiles();
    await pollEmbeddingStatus();
  }, [getContextId, pollContextDocsAndFiles, pollEmbeddingStatus, setChips]);

  useEffect(() => {
    mountedRef.current = true;
    const handleIncomingContext = (
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
      const hasContextPayload =
        context.docs ||
        context.attachments ||
        context.snapshot ||
        context.combinedElementsMarkdown ||
        context.html;
      if (!hasContextPayload) return;

      setTimeout(() => {
        void (async () => {
          const previous = chipsRef.current.find(isSelectedContextChip);
          if (previous) await removeChip(previous);
          const ctx = latestRef.current.chatContextValue;
          const selectedChip: SelectedContextChip = {
            uuid: uuidv4(),
            snapshot: ctx.snapshot ?? null,
            combinedElementsMarkdown: ctx.combinedElementsMarkdown ?? null,
            html: ctx.html ?? null,
            state: "finished",
          };
          await Promise.all([
            addChip(selectedChip, true),
            ...(ctx.docs ?? []).map((id) =>
              addChip({ docId: id, state: "processing" }, true),
            ),
            ...(ctx.attachments ?? []).map((att) =>
              addChip(
                { sourceId: att.sourceId, name: att.name, state: "processing" },
                true,
              ),
            ),
          ]);
        })().catch(console.error);
      }, 0);
    };

    const openSub = AIProvider.slots.requestOpenWithChat.subscribe(
      handleIncomingContext,
    );
    const sendSub = AIProvider.slots.requestSendWithChat.subscribe(
      handleIncomingContext,
    );

    return () => {
      mountedRef.current = false;
      openSub.unsubscribe();
      sendSub.unsubscribe();
      stopPolling();
      stopEmbeddingPolling();
    };
  }, [addChip, removeChip, stopEmbeddingPolling, stopPolling]);

  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    const nextId = options.session?.sessionId;
    if (prevId && prevId !== nextId) {
      stopPolling();
      stopEmbeddingPolling();
      contextIdRef.current = undefined;
      setChips([]);
    }
    prevSessionIdRef.current = nextId;
    if (nextId && (!contextIdRef.current || prevId !== nextId)) {
      void loadSessionChips().catch(console.error);
    }
  }, [
    loadSessionChips,
    options.session?.sessionId,
    setChips,
    stopEmbeddingPolling,
    stopPolling,
  ]);

  useEffect(() => {
    if (
      prevStatusRef.current !== "loading" &&
      options.chatContextValue.status === "loading"
    ) {
      setIsChipsCollapsed(true);
    }
    prevStatusRef.current = options.chatContextValue.status;
  }, [options.chatContextValue.status]);

  const addImages = useCallback((incoming: File[]) => {
    const current = latestRef.current.chatContextValue.images;
    if (current.length + incoming.length > MAX_IMAGE_COUNT) {
      latestRef.current.notificationService.toast(
        chatI18n()["com.myoxus.ai.chat-panel.image-count-limit"]({
          count: String(MAX_IMAGE_COUNT),
        }),
      );
    }
    latestRef.current.updateContext({
      images: [...current, ...incoming].slice(0, MAX_IMAGE_COUNT),
    });
  }, []);

  return {
    chips,
    isChipsCollapsed,
    isContextProcessing: chips.some((c) => c.state === "processing"),
    toggleChipsCollapsed: () => setIsChipsCollapsed((prev) => !prev),
    addChip,
    updateChip,
    removeChip,
    retryFileChip,
    retryAttachmentChip,
    addImages,
  };
}
