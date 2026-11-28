// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { handleError } from "./copilot-client";
import { GeneralNetworkError, RequestTimeoutError } from "./error";

export type MyoxusTextEvent = {
  type: "attachment" | "message";
  data: string;
};

type MyoxusTextStream = AsyncIterable<MyoxusTextEvent>;

type TextStreamOptions = {
  timeout?: number;
  signal?: AbortSignal;
  onRetrievalStatus?: (available: boolean) => void;
};

type TerminalKind = "done" | "failed" | "aborted";

const CONNECTION_ENDED_MESSAGE = "Copilot connection ended before completion";
const INVALID_ERROR_FRAME_MESSAGE = "Invalid Copilot stream error response";

function decodeErrorFrame(raw: string): Error {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      const code =
        "code" in parsed && typeof parsed.code === "string"
          ? parsed.code
          : "INTERNAL_SERVER_ERROR";
      const status =
        "status" in parsed && typeof parsed.status === "number"
          ? parsed.status
          : 500;
      return handleError({
        code,
        type: code,
        name: code,
        message: parsed.message,
        status,
      });
    }
  } catch {
    // Malformed frames must not leak raw payloads into user-facing errors.
  }
  return new GeneralNetworkError(INVALID_ERROR_FRAME_MESSAGE);
}

function decodeRetrievalAvailability(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      "available" in parsed &&
      parsed.available === true
    );
  } catch {
    return false;
  }
}

/**
 * Wraps a single-shot Copilot `EventSource` as an async iterable.
 * Only an explicit `done` event finishes cleanly; transport closure fails
 * closed, queued chunks drain before completion/failure, and terminal events
 * close immediately so the browser cannot auto-reconnect.
 */
export function toTextStream(
  eventSource: EventSource,
  options: TextStreamOptions = {},
): MyoxusTextStream {
  const { timeout, signal, onRetrievalStatus } = options;

  return {
    [Symbol.asyncIterator]: async function* () {
      const buffer: MyoxusTextEvent[] = [];
      let terminal: TerminalKind | undefined;
      let terminalError: Error | undefined;
      let notify: (() => void) | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const clearIdleTimer = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };

      const finish = (kind: TerminalKind, err?: Error) => {
        if (terminal) return;
        terminal = kind;
        terminalError = err;
        eventSource.close();
        notify?.();
      };

      const onChunk = (event: Event) => {
        if (terminal) return;
        buffer.push({
          type: event.type as MyoxusTextEvent["type"],
          data: (event as MessageEvent<string>).data,
        });
        notify?.();
      };

      const onRetrieval = (event: Event) => {
        if (terminal) return;
        onRetrievalStatus?.(
          decodeRetrievalAvailability((event as MessageEvent<string>).data),
        );
      };

      const onDone = () => finish("done");

      const onError = (event: Event) => {
        if (terminal) return;
        const payload = (event as MessageEvent<string>).data;
        const err =
          typeof payload === "string" && payload.length > 0
            ? decodeErrorFrame(payload)
            : new GeneralNetworkError(CONNECTION_ENDED_MESSAGE);
        finish("failed", err);
      };

      const onAbort = () => {
        const reason =
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("Copilot request aborted", "AbortError");
        finish("aborted", reason);
      };

      eventSource.addEventListener("message", onChunk);
      eventSource.addEventListener("attachment", onChunk);
      eventSource.addEventListener("retrieval-status", onRetrieval);
      eventSource.addEventListener("done", onDone);
      eventSource.addEventListener("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });

      if (signal?.aborted) {
        onAbort();
      }

      try {
        while (true) {
          if (terminal === "aborted") {
            throw terminalError;
          }

          const item = buffer.shift();
          if (item) {
            yield item;
            continue;
          }

          if (terminal === "failed") {
            throw terminalError;
          }
          if (terminal === "done") {
            return;
          }
          if (eventSource.readyState === 2) {
            throw new GeneralNetworkError(CONNECTION_ENDED_MESSAGE);
          }

          try {
            await new Promise<void>((resolve) => {
              notify = resolve;
              if (timeout !== undefined && timeout > 0) {
                idleTimer = setTimeout(
                  () => finish("failed", new RequestTimeoutError()),
                  timeout,
                );
              }
            });
          } finally {
            clearIdleTimer();
            notify = undefined;
          }
        }
      } finally {
        clearIdleTimer();
        eventSource.removeEventListener("message", onChunk);
        eventSource.removeEventListener("attachment", onChunk);
        eventSource.removeEventListener("retrieval-status", onRetrieval);
        eventSource.removeEventListener("done", onDone);
        eventSource.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
        eventSource.close();
      }
    },
  };
}
