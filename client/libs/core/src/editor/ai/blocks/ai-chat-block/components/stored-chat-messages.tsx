// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { PeekViewService } from "@myoxus/core/modules/peek-view";
import { MyoxusAIIcon } from "./icon";
import {
  Avatar,
  Box,
  Group,
  MediaPreviewFrame,
  MediaPreviewImage,
  MyoxusText,
  Stack,
} from "@myoxus/ui-facade";
import { NotificationProvider } from "@virgultum/core/services";
import type { EditorHost } from "@virgultum/editor/std";

import type { DocDisplayConfig } from "../../../components/ai-chat-chips";
import type {
  ChatMessage,
  CopilotGeneratedFile,
} from "../../../components/ai-chat-messages";
import { CopilotResponseActions } from "../../../components/response-actions";
import { StreamParts } from "../../../components/ai-message-content/stream-parts";
import { StoredToolView } from "../../../components/ai-message-content/stored-tool-view";
import { StoredAnswerText } from "../../../components/ai-message-content/stored-answer-text";

export function StoredChatMessages({
  host,
  messages,
  peekViewService,
  docDisplayConfig,
  showGeneratedFiles,
  readOnly,
  state = "finished",
  downloadSavedFile,
}: {
  host: EditorHost;
  messages: readonly ChatMessage[];
  peekViewService?: PeekViewService;
  docDisplayConfig?: DocDisplayConfig;
  showGeneratedFiles?: boolean;
  readOnly?: boolean;
  state?: "finished" | "generating";
  downloadSavedFile?: (
    file: CopilotGeneratedFile,
    current: () => boolean,
  ) => Promise<void>;
}) {
  const renderText = (text: string, annotation = false) => (
    <StoredAnswerText host={host} text={text} annotation={annotation} />
  );
  const notifications = host.std.get(NotificationProvider);
  return (
    <Stack gap="xl">
      {messages.map((message) => (
        <Stack key={message.id || message.createdAt} gap="xs">
          <Group wrap="nowrap" gap="sm">
            {message.role === "user" ? (
              <Avatar
                name={message.userName}
                url={message.avatarUrl}
                size="sm"
              />
            ) : (
              <MyoxusAIIcon />
            )}
            <MyoxusText typographySlot="nav">
              {message.role === "user"
                ? (message.userName ?? "You")
                : "Myoxus AI"}
            </MyoxusText>
          </Group>
          <Stack gap="sm" pl="xl">
            {message.attachments?.length ? (
              <Group gap="sm">
                {message.attachments.map((source) => (
                  <MediaPreviewFrame key={source} aspectRatio="auto">
                    <MediaPreviewImage alt="" src={source} />
                  </MediaPreviewFrame>
                ))}
              </Group>
            ) : null}
            <Box>
              {message.streamObjects?.length ? (
                <StreamParts
                  answer={message.streamObjects}
                  state={state}
                  showReasoning
                  renderText={renderText}
                  renderTool={(data) => (
                    <StoredToolView
                      data={data}
                      host={host}
                      readOnly={readOnly}
                      generating={state === "generating"}
                      docDisplayService={docDisplayConfig}
                      peekViewService={peekViewService}
                      renderRichText={renderText}
                    />
                  )}
                />
              ) : (
                renderText(message.content)
              )}
            </Box>
            {showGeneratedFiles && message.generatedFiles?.length ? (
              <CopilotResponseActions
                messageId={message.id}
                generatedFiles={message.generatedFiles}
                downloadSavedFile={downloadSavedFile}
                notificationService={notifications}
              />
            ) : null}
          </Stack>
        </Stack>
      ))}
    </Stack>
  );
}
