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

function parseStreamError(data: string) {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string"
    ) {
      const code =
        "code" in payload && typeof payload.code === "string"
          ? payload.code
          : "INTERNAL_SERVER_ERROR";
      // The deployed SSE envelope has code/message, not GraphQL extensions.
      // Supply the existing error mapper's shape without discarding its code.
      return handleError({
        code,
        type: code,
        name: code,
        message: payload.message,
        status:
          "status" in payload && typeof payload.status === "number"
            ? payload.status
            : 500,
      });
    }
  } catch {
    // Invalid wire data is not diagnostic copy and must not enter errors.
  }
  return new GeneralNetworkError("Invalid Copilot stream error response");
}

/** One owned connection: only done is success; transport close is never done.
 * Queued output drains before a terminal result, and terminal listeners close
 * immediately so EventSource cannot reconnect and start another response.
 */
export function toTextStream(
  eventSource: EventSource,
  { timeout, signal, onRetrievalStatus }: TextStreamOptions = {},
): MyoxusTextStream {
  return {
    [Symbol.asyncIterator]: async function* () {
      const queue: MyoxusTextEvent[] = [];
      let terminal: "done" | "failed" | "aborted" | undefined;
      let failure: Error | undefined;
      let wake: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (state: NonNullable<typeof terminal>, error?: Error) => {
        if (terminal) return;
        terminal = state;
        failure = error;
        eventSource.close();
        wake?.();
      };
      const messageListener = (event: Event) => {
        if (terminal) return;
        queue.push({
          type: event.type as MyoxusTextEvent["type"],
          data: (event as MessageEvent<string>).data,
        });
        wake?.();
      };
      const doneListener = () => settle("done");
      const retrievalListener = (event: Event) => {
        if (terminal) return;
        let available = false;
        try {
          const payload: unknown = JSON.parse(
            (event as MessageEvent<string>).data,
          );
          available =
            !!payload &&
            typeof payload === "object" &&
            "available" in payload &&
            payload.available === true;
        } catch {
          // Invalid metadata must not claim a successful search or become text.
        }
        onRetrievalStatus?.(available);
      };
      const errorListener = (event: Event) => {
        if (terminal) return;
        const data = (event as MessageEvent<string>).data;
        settle(
          "failed",
          typeof data === "string" && data
            ? parseStreamError(data)
            : new GeneralNetworkError(
                "Copilot connection ended before completion",
              ),
        );
      };
      const abortListener = () =>
        settle(
          "aborted",
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException("Copilot request aborted", "AbortError"),
        );

      eventSource.addEventListener("message", messageListener);
      eventSource.addEventListener("attachment", messageListener);
      eventSource.addEventListener("retrieval-status", retrievalListener);
      eventSource.addEventListener("done", doneListener);
      eventSource.addEventListener("error", errorListener);
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) abortListener();

      try {
        while (true) {
          // Abort releases an idle reader immediately; queued data cannot turn
          // an explicit stop into a successful postfix/result.
          if (terminal === "aborted") throw failure;
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (terminal === "failed") throw failure;
          if (terminal === "done") return;
          if (eventSource.readyState === 2) {
            throw new GeneralNetworkError(
              "Copilot connection ended before completion",
            );
          }
          try {
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (timeout !== undefined && timeout > 0) {
                timer = setTimeout(
                  () => settle("failed", new RequestTimeoutError()),
                  timeout,
                );
              }
            });
          } finally {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            wake = undefined;
          }
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        eventSource.removeEventListener("message", messageListener);
        eventSource.removeEventListener("attachment", messageListener);
        eventSource.removeEventListener("retrieval-status", retrievalListener);
        eventSource.removeEventListener("done", doneListener);
        eventSource.removeEventListener("error", errorListener);
        signal?.removeEventListener("abort", abortListener);
        eventSource.close();
      }
    },
  };
}
