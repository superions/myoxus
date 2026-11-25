// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type ComponentProps } from "react";
import { Box } from "@myoxus/ui-facade";
import { isInsidePageEditor } from "@virgultum/editor/shared/utils";
import {
  ChatAssistantIdentity,
  ChatLoading,
  ChatMessageSurface,
} from "../../components/message-chrome";
import { CopilotResponseActions } from "../../components/response-actions";
import { ChatContentImages } from "../../components/ai-message-content/images";
import { StoredAnswerText } from "../../components/ai-message-content/stored-answer-text";
import { StreamObjectsView } from "../../components/ai-message-content/stream-objects";
import type {
  ChatMessage,
  ChatStatus,
} from "../../components/ai-chat-messages/type";
import {
  EdgelessEditorActions,
  PageEditorActions,
} from "../../_common/chat-actions-handle";
import { AIChatErrorRenderer } from "../../messages/error";
import type { AIError } from "../../provider";
import { mergeStreamContent } from "../../utils/stream-objects";

type ReplyProps = Omit<
  ComponentProps<typeof StreamObjectsView>,
  "state" | "answer" | "readOnly" | "reasoningIdentity" | "notificationService"
> & {
  notificationService: NonNullable<
    ComponentProps<typeof StreamObjectsView>["notificationService"]
  >;
  item: ChatMessage;
  status: ChatStatus;
  error: AIError | null;
  retry?: () => void;
  sessionId?: string;
};

export function AssistantReply({
  item,
  status,
  error,
  retry,
  sessionId,
  ...context
}: ReplyProps) {
  const { host, independentMode, notificationService } = context;
  const parts = item.streamObjects;
  const text = parts?.length ? mergeStreamContent(parts) : item.content;
  const generating = status === "transmitting";
  const state = generating ? "generating" : "finished";
  const failure =
    status === "error" && error ? AIChatErrorRenderer(error, host) : null;
  const identity = (
    <ChatAssistantIdentity
      withDocs={/\[\^\d+\]:\{"type":"doc","docId":"[^"]+"\}/.test(item.content)}
    />
  );
  const reasoningFirst = parts?.[0]?.type === "reasoning";
  const actions =
    generating || status === "loading" ? null : (
      <CopilotResponseActions
        host={host}
        sessionId={sessionId}
        actions={
          host && text && !independentMode
            ? isInsidePageEditor(host)
              ? PageEditorActions
              : EdgelessEditorActions
            : undefined
        }
        content={text}
        messageId={item.id}
        generatedFiles={item.generatedFiles}
        exportable={
          !!text.trim() &&
          !host?.store.readonly &&
          status !== "error" &&
          (item.params?.streamStatus === undefined ||
            item.params.streamStatus === "done")
        }
        retry={retry}
        notificationService={notificationService}
      />
    );
  const empty =
    !item.content.trim() && !parts?.length && !item.attachments?.length;
  // A stopped empty reply retains its retry action without adding an empty speaker row.
  return (
    <Box data-testid="chat-message-assistant" data-status={status}>
      {status === "loading" ? (
        <ChatLoading />
      ) : empty && !generating && !failure ? (
        actions
      ) : (
        <ChatMessageSurface
          assistant
          identity={reasoningFirst ? undefined : identity}
        >
          {item.attachments?.length ? (
            <ChatContentImages images={item.attachments} />
          ) : null}
          {parts?.length ? (
            <StreamObjectsView
              {...context}
              answer={parts}
              state={state}
              reasoningIdentity={reasoningFirst ? identity : undefined}
            />
          ) : (
            <StoredAnswerText host={host} text={item.content} />
          )}
          {failure}
          {actions}
        </ChatMessageSurface>
      )}
    </Box>
  );
}
