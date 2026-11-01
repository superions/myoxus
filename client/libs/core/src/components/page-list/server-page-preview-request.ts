// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Server } from "../../modules/server/entities/server";
import type { ServerConfig } from "../../modules/server/types";

export type PagePreviewResult =
  | {
      state: "ready";
      blob: Blob;
      revision: string | null;
      contentHeight: number;
      partial: boolean | null;
      truncated: boolean | null;
    }
  | { state: "empty" | "unsupported" | "failed" | "unavailable" };

type WaitingRequest = { start: () => void; cancel: () => void };
type RequestQueue = {
  active: number;
  limit: number;
  waiting: WaitingRequest[];
};
const queues = new WeakMap<Server, RequestQueue>();

function previewDimension(
  value: string | null,
  maximum: number,
): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function previewStatus(value: string | null): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

function drain(queue: RequestQueue) {
  while (queue.active < queue.limit && queue.waiting.length) {
    queue.waiting.shift()!.start();
  }
}

// A server-scoped queue bounds visible-card bursts. Aborted cards leave the
// waiting queue immediately; active requests keep their slot until fetch exits.
function admitted<T>(
  server: Server,
  limit: number,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const queue = queues.get(server) ?? { active: 0, limit, waiting: [] };
  queue.limit = limit;
  queues.set(server, queue);
  return new Promise<T>((resolve, reject) => {
    const request: WaitingRequest = {
      cancel() {
        const index = queue.waiting.indexOf(request);
        if (index !== -1) queue.waiting.splice(index, 1);
        signal.removeEventListener("abort", request.cancel);
        reject(signal.reason);
      },
      start() {
        signal.removeEventListener("abort", request.cancel);
        queue.active++;
        void work()
          .then(resolve, reject)
          .finally(() => {
            queue.active--;
            drain(queue);
          });
      },
    };
    signal.addEventListener("abort", request.cancel, { once: true });
    queue.waiting.push(request);
    drain(queue);
  });
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function requestPagePreview(
  server: Server,
  workspaceId: string,
  docId: string,
  policy: NonNullable<ServerConfig["preview"]>,
  signal: AbortSignal,
  colorScheme: "light" | "dark",
): Promise<PagePreviewResult> {
  if (
    !Number.isSafeInteger(policy.maxConcurrentRequests) ||
    policy.maxConcurrentRequests <= 0 ||
    !Number.isSafeInteger(policy.retryCount) ||
    policy.retryCount < 0 ||
    !Number.isSafeInteger(policy.requestTimeoutMs) ||
    policy.requestTimeoutMs <= 0
  ) {
    return { state: "failed" };
  }
  return admitted<PagePreviewResult>(
    server,
    policy.maxConcurrentRequests,
    signal,
    async () => {
      // Queueing is backpressure, not a running request. Each admitted fetch
      // gets the configured budget, including retries and body consumption;
      // card cancellation still removes waiting work immediately.
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new Error("Preview timed out")),
        policy.requestTimeoutMs,
      );
      const operationSignal = AbortSignal.any([signal, timeout.signal]);
      try {
        for (let attempt = 0; ; attempt++) {
          const response = await server.fetch(
            `/api/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/preview?${new URLSearchParams({ colorScheme })}`,
            {
              signal: operationSignal,
              credentials: "include",
              // The browser merges an authorized 304 with its retained body.
              cache: "no-cache",
              timeout: 0,
              throwOnHttpError: false,
            },
          );
          if (response.status === 204) return { state: "empty" };
          if ([401, 403, 404].includes(response.status))
            return { state: "unavailable" };
          if (response.ok) {
            if (
              response.headers.get("content-type")?.split(";")[0] !==
              "image/svg+xml"
            ) {
              return { state: "failed" };
            }
            return {
              state: "ready",
              blob: await response.blob(),
              revision: response.headers.get("x-doc-revision"),
              contentHeight:
                previewDimension(
                  response.headers.get("x-preview-content-height"),
                  previewDimension(
                    response.headers.get("x-preview-height"),
                    400,
                  ) ?? 400,
                ) ?? 400,
              partial: previewStatus(response.headers.get("x-preview-partial")),
              truncated: previewStatus(
                response.headers.get("x-preview-truncated"),
              ),
            };
          }
          if (
            response.status === 422 &&
            response.headers.get("content-type")?.includes("application/json")
          ) {
            const body: unknown = await response.json();
            if (
              body &&
              typeof body === "object" &&
              "code" in body &&
              body.code === "unsupported_mode"
            ) {
              return { state: "unsupported" };
            }
          }
          if (
            ![409, 429, 503].includes(response.status) ||
            attempt >= policy.retryCount
          ) {
            return { state: "failed" };
          }
          const seconds = Number(response.headers.get("retry-after") ?? 0);
          await delay(
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
            operationSignal,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  );
}
