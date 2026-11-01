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

const TIMEOUT = 50000;

export type TextToTextOptions = {
  client: CopilotClient;
  sessionId: string;
  content?: string;
  attachments?: MessageAttachment[];
  host?: EditorHost;
  persistAttachment?: AttachmentPersister;
  params?: Record<string, any>;
  timeout?: number;
  /** Null defers native chat lifetime to the provider's bounded deadline while
   * retaining the independent message/upload request timeout.
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

export type ToImageOptions = TextToTextOptions & {
  seed?: string;
};

interface CreateMessageOptions {
  requestId?: string;
  client: CopilotClient;
  sessionId: string;
  content?: string;
  attachments?: MessageAttachment[];
  host?: EditorHost;
  persistAttachment?: AttachmentPersister;
  params?: Record<string, any>;
  timeout?: number;
  signal?: AbortSignal;
}

async function createMessage({
  requestId,
  client,
  sessionId,
  content,
  attachments,
  host,
  persistAttachment,
  params,
  timeout,
  signal,
}: CreateMessageOptions): Promise<string> {
  signal?.throwIfAborted();
  const options: Parameters<CopilotClient["createMessage"]>[0] = {
    sessionId,
    requestId,
    content,
    params,
  };

  const resolvedAttachments = await resolveCreateMessageAttachments({
    attachments,
    host,
    persistAttachment,
    signal,
  });
  if (resolvedAttachments?.length) {
    options.attachments = resolvedAttachments;
  }

  signal?.throwIfAborted();
  return await client.createMessage(options, { timeout, signal });
}

export function textToText({
  client,
  sessionId,
  content,
  attachments,
  host,
  persistAttachment,
  params,
  stream,
  signal,
  timeout = TIMEOUT,
  streamTimeout,
  retry = false,
  requestId,
  messageId: originalMessageId,
  responseId,
  expectedStreamId,
  endpoint = Endpoint.StreamObject,
  postfix,
  reasoning,
  modelId,
  toolsConfig,
  onRetrievalStatus,
  onMessageCreated,
}: TextToTextOptions) {
  let messageId = originalMessageId;
  const textEventTimeout =
    streamTimeout === null ? undefined : (streamTimeout ?? timeout);

  if (stream) {
    return {
      [Symbol.asyncIterator]: async function* () {
        signal?.throwIfAborted();
        if (!retry) {
          messageId = await createMessage({
            requestId,
            client,
            sessionId,
            content,
            attachments,
            host,
            persistAttachment,
            params,
            timeout,
            signal,
          });
        }
        signal?.throwIfAborted();
        if (!retry && messageId) await onMessageCreated?.(messageId);
        signal?.throwIfAborted();
        const eventSource = client.chatTextStream(
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
        AIProvider.LAST_ACTION_SESSIONID = sessionId;

        if (postfix) {
          const messages: string[] = [];
          for await (const event of toTextStream(eventSource, {
            timeout: textEventTimeout,
            signal,
            onRetrievalStatus,
          })) {
            if (event.type === "message") {
              messages.push(event.data);
            }
          }
          yield postfix(messages.join(""));
        } else {
          for await (const event of toTextStream(eventSource, {
            timeout: textEventTimeout,
            signal,
            onRetrievalStatus,
          })) {
            if (event.type === "message") {
              yield event.data;
            }
          }
        }
      },
    };
  } else {
    return (async function () {
      signal?.throwIfAborted();
      if (!retry) {
        messageId = await createMessage({
          requestId,
          client,
          sessionId,
          content,
          attachments,
          host,
          persistAttachment,
          params,
          timeout,
          signal,
        });
      }
      signal?.throwIfAborted();
      if (!retry && messageId) await onMessageCreated?.(messageId);
      signal?.throwIfAborted();
      const eventSource = client.chatTextStream(
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
      AIProvider.LAST_ACTION_SESSIONID = sessionId;

      const messages: string[] = [];
      for await (const event of toTextStream(eventSource, {
        timeout: textEventTimeout,
        signal,
        onRetrievalStatus,
      })) {
        if (event.type === "message") {
          messages.push(event.data);
        }
      }

      const result = messages.join("");
      return postfix ? postfix(result) : result;
    })();
  }
}

// Only one image is currently being processed
export function toImage({
  content,
  sessionId,
  attachments,
  host,
  persistAttachment,
  params,
  seed,
  signal,
  timeout = TIMEOUT,
  retry = false,
  endpoint,
  client,
}: ToImageOptions) {
  let messageId: string | undefined;
  return {
    [Symbol.asyncIterator]: async function* () {
      signal?.throwIfAborted();
      if (!retry) {
        messageId = await createMessage({
          client,
          sessionId,
          content,
          attachments,
          host,
          persistAttachment,
          params,
          timeout,
          signal,
        });
      }
      const eventSource = client.imagesStream(
        sessionId,
        messageId,
        seed,
        endpoint,
      );
      AIProvider.LAST_ACTION_SESSIONID = sessionId;

      for await (const event of toTextStream(eventSource, {
        timeout,
        signal,
      })) {
        if (event.type === "attachment") {
          yield event.data;
        }
      }
    },
  };
}
