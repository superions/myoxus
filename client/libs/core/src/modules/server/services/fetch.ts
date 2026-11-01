import { DebugLogger } from "@myoxus/debug";
import { desktopServerRequestUrl } from "@myoxus/desktop-api-contract";
import { UserFriendlyError } from "@myoxus/error";
import { fromPromise, Service } from "@myoxus/infra";

import type { ServerService } from "./server";

const logger = new DebugLogger("myoxus:fetch");

export type FetchInit = RequestInit & {
  timeout?: number;
  /**
   * Defaults to true. Set to false only for endpoints where the caller owns
   * non-2xx semantics, e.g. `/api/auth/challenge` where 503 means "disabled".
   */
  throwOnHttpError?: boolean;
};

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

export class FetchService extends Service {
  constructor(private readonly serverService: ServerService) {
    super();
  }
  rxFetch = (
    input: string,
    init?: RequestInit & {
      // https://github.com/microsoft/TypeScript/issues/54472
      priority?: "auto" | "low" | "high";
    } & {
      traceEvent?: string;
    },
  ) => {
    return fromPromise((signal) => {
      return this.fetch(input, { signal, ...init });
    });
  };

  /**
   * fetch with custom custom timeout and error handling.
   */
  fetch = async (input: string, init?: FetchInit): Promise<Response> => {
    logger.debug("fetch", input);
    const { timeout, throwOnHttpError = true, ...requestInit } = init ?? {};
    const externalSignal = requestInit.signal;
    if (externalSignal?.aborted) {
      throw externalSignal.reason;
    }
    const abortController = new AbortController();
    externalSignal?.addEventListener("abort", (reason) => {
      abortController.abort(reason);
    });

    const requestTimeout = timeout ?? 15000;
    const timeoutId =
      requestTimeout > 0
        ? setTimeout(() => {
            abortController.abort(
              new Error("timeout after " + requestTimeout + "ms"),
            );
          }, requestTimeout)
        : undefined;

    let res: Response;

    try {
      const server = this.serverService.server;
      const target = new URL(input, server.baseUrl);
      if (
        BUILD_CONFIG.isElectron &&
        target.origin !== new URL(server.baseUrl).origin
      ) {
        throw new Error("A server-scoped request cannot target another origin");
      }
      res = await globalThis.fetch(
        BUILD_CONFIG.isElectron
          ? desktopServerRequestUrl(server.id, target.pathname + target.search)
          : target,
        {
          ...requestInit,
          signal: abortController.signal,
          headers: {
            ...headersToRecord(requestInit.headers),
            "x-myoxus-version": BUILD_CONFIG.appVersion,
          },
        },
      );
    } catch (err: any) {
      const isAbort =
        err?.name === "AbortError" ||
        err?.code === "ABORT_ERR" ||
        err?.type === "aborted" ||
        abortController.signal.aborted;

      const message =
        err?.message || (isAbort ? "Request aborted" : "Unknown network error");

      throw new UserFriendlyError({
        status: isAbort ? 499 : 504,
        code: isAbort ? "REQUEST_ABORTED" : "NETWORK_ERROR",
        type: isAbort ? "REQUEST_ABORTED" : "NETWORK_ERROR",
        name: isAbort ? "REQUEST_ABORTED" : "NETWORK_ERROR",
        message: `Network error: ${message}`,
        stacktrace: err?.stack,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (throwOnHttpError && !res.ok) {
      if (res.status === 504) {
        const error = new Error("Gateway Timeout");
        logger.debug("network error", error);
        throw new UserFriendlyError({
          status: 504,
          code: "NETWORK_ERROR",
          type: "NETWORK_ERROR",
          name: "NETWORK_ERROR",
          message: "Gateway Timeout",
          stacktrace: error.stack,
        });
      } else {
        if (res.headers.get("Content-Type")?.startsWith("application/json")) {
          throw UserFriendlyError.fromAny(await res.json());
        } else {
          throw UserFriendlyError.fromAny(await res.text());
        }
      }
    }

    return res;
  };
}
