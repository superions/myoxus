// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { AIToolsConfig } from "@myoxus/core/modules/ai-button";
import type { EditorHost } from "@virgultum/editor/std";

import { AIProvider } from "./ai-provider";
import { type CopilotClient, Endpoint } from "./copilot-client";
import { toTextStream } from "./event-source";
import {
  type AttachmentPersister,
  type MessageAttachment,
  resolveCreateMessageAttachments,
} from "./request-attachments";

const DEFAULT_TIMEOUT_MS = 50_000;

export type TextToTextOptions = {
  client: CopilotClient;
  sessionId: string;
  content?: string;
  attachments?: MessageAttachment[];
  host?: EditorHost;
  persistAttachment?: AttachmentPersister;
  params?: Record<string, unknown>;
  timeout?: number;
  /**
   * `null` delegates stream lifetime to the server provider while keeping the
   * independent upload/message timeout.
   */
  streamTimeout?: number | null;
  stream?: boolean;
  signal?: AbortSignal;
  retry?: boolean;
  requestId?: string;
  messageId?: string;
  responseId?: string;
  expectedStreamId?: string;
  endpoint?: Endpoint;
  isRootSession?: boolean;
  postfix?: (text: string) => string;
  reasoning?: boolean;
  modelId?: string;
  toolsConfig?: AIToolsConfig;
  onRetrievalStatus?: (available: boolean) => void;
  onMessageCreated?: (messageId: string) => void | Promise<void>;
};

async function openGenerationStream(
  options: TextToTextOptions,
  timeout: number,
): Promise<EventSource> {
  const {
    client,
    sessionId,
    content,
    attachments,
    host,
    persistAttachment,
    params,
    signal,
    retry = false,
    requestId,
    responseId,
    expectedStreamId,
    endpoint = Endpoint.StreamObject,
    reasoning,
    modelId,
    toolsConfig,
    onMessageCreated,
  } = options;

  let messageId = options.messageId;
  signal?.throwIfAborted();

  if (!retry) {
    const resolvedAttachments = await resolveCreateMessageAttachments({
      attachments,
      host,
      persistAttachment,
      signal,
    });
    signal?.throwIfAborted();
    messageId = await client.createMessage(
      {
        sessionId,
        requestId,
        content,
        params,
        ...(resolvedAttachments?.length
          ? { attachments: resolvedAttachments }
          : {}),
      },
      { timeout, signal },
    );
    signal?.throwIfAborted();
    if (messageId) {
      await onMessageCreated?.(messageId);
    }
  }

  signal?.throwIfAborted();
  AIProvider.LAST_ACTION_SESSIONID = sessionId;

  return client.chatTextStream(
    {
      sessionId,
      messageId,
      requestId,
      responseId,
      expectedStreamId,
      reasoning,
      modelId,
      toolsConfig,
    },
    endpoint,
  );
}

async function collectMessages(
  eventSource: EventSource,
  streamTimeout: number | undefined,
  signal: AbortSignal | undefined,
  onRetrievalStatus: ((available: boolean) => void) | undefined,
): Promise<string> {
  const parts: string[] = [];
  for await (const event of toTextStream(eventSource, {
    timeout: streamTimeout,
    signal,
    onRetrievalStatus,
  })) {
    if (event.type === "message") {
      parts.push(event.data);
    }
  }
  return parts.join("");
}

export function textToText(options: TextToTextOptions) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const eventTimeout =
    options.streamTimeout === null
      ? undefined
      : (options.streamTimeout ?? timeout);

  if (options.stream) {
    return {
      [Symbol.asyncIterator]: async function* () {
        const eventSource = await openGenerationStream(options, timeout);
        if (options.postfix) {
          const combined = await collectMessages(
            eventSource,
            eventTimeout,
            options.signal,
            options.onRetrievalStatus,
          );
          yield options.postfix(combined);
          return;
        }

        for await (const event of toTextStream(eventSource, {
          timeout: eventTimeout,
          signal: options.signal,
          onRetrievalStatus: options.onRetrievalStatus,
        })) {
          if (event.type === "message") {
            yield event.data;
          }
        }
      },
    };
  }

  return (async () => {
    const eventSource = await openGenerationStream(options, timeout);
    const combined = await collectMessages(
      eventSource,
      eventTimeout,
      options.signal,
      options.onRetrievalStatus,
    );
    return options.postfix ? options.postfix(combined) : combined;
  })();
}
