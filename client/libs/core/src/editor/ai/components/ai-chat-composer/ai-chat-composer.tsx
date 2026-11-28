// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type {
  AIDraftService,
  AIToolsConfigService,
} from "@myoxus/core/modules/ai-button";
import type { AIModelService } from "@myoxus/core/modules/ai-button/services/models";
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
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
import { useCallback } from "react";

import type { SearchMenuConfig } from "../ai-chat-add-context";
import type { DocDisplayConfig } from "../ai-chat-chips";
import { ChatPanelChips } from "../ai-chat-chips/chat-panel-chips";
import {
  AIChatInput,
  type AIChatInputContext,
  type AIReasoningConfig,
} from "../ai-chat-input";
import { chatI18n } from "../chat-i18n";
import { useChatContextChips } from "../hooks/use-chat-context-chips";
import { ChatDisclaimer, ChatScrollToLatest } from "../message-chrome";

export const EMBEDDING_STATUS_CHECK_INTERVAL = 10000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DROPZONE_MIME_ACCEPT = {
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
}

/** Composes context chips, drag-and-drop uploads, and chat prompt input on Mantine Facade. */
export function AIChatComposer(props: AIChatComposerProps) {
  const {
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
  } = props;

  const {
    chips,
    isChipsCollapsed,
    isContextProcessing,
    toggleChipsCollapsed,
    addChip,
    updateChip,
    removeChip,
    retryFileChip,
    retryAttachmentChip,
    addImages,
  } = useChatContextChips({
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

  const dropDisabled =
    chatContextValue.status === "loading" ||
    chatContextValue.status === "transmitting";

  const handleDrop = useCallback(
    (files: File[]) => {
      if (dropDisabled) return;
      const images = files.filter((file) => file.type.startsWith("image/"));
      if (images.length) addImages(images);

      const documents = files.filter((file) => !file.type.startsWith("image/"));
      void Promise.all(
        documents.map(async (file) => {
          if (file.size > MAX_UPLOAD_BYTES) {
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
    [addChip, addImages, dropDisabled],
  );

  const handleReject = useCallback(
    (rejections: FileRejection[]) => {
      if (dropDisabled) return;
      for (const rejection of rejections) {
        if (rejection.file.size > MAX_UPLOAD_BYTES) {
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
    [dropDisabled],
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
          accept={DROPZONE_MIME_ACCEPT}
          maxSize={MAX_UPLOAD_BYTES}
          onDrop={handleDrop}
          onReject={handleReject}
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
              toggleCollapse={toggleChipsCollapsed}
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
