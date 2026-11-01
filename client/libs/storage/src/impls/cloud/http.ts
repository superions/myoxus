import { desktopServerRequestUrl } from "@myoxus/desktop-api-contract";
import { UserFriendlyError } from "@myoxus/error";
import { gqlFetcherFactory } from "@myoxus/graphql";

import { DummyConnection } from "../../connection";
import { withMyoxusStorageClientContextHeaders } from "./client-context";

export class HttpConnection extends DummyConnection {
  readonly fetch = async (
    input: string,
    init?: RequestInit & { timeout?: number },
  ) => {
    const target = new URL(input, this.serverBaseUrl);
    const sameServer = target.origin === new URL(this.serverBaseUrl).origin;
    // Signed object-storage URLs are explicit, anonymous downloads/uploads;
    // only requests to this connection's server use its native identity.
    const requestUrl =
      BUILD_CONFIG.isElectron && sameServer
        ? desktopServerRequestUrl(
            this.serverId ?? "",
            target.pathname + target.search,
          )
        : target;
    const externalSignal = init?.signal;
    if (externalSignal?.aborted) {
      throw externalSignal.reason;
    }

    const abortController = new AbortController();
    externalSignal?.addEventListener("abort", (reason) => {
      abortController.abort(reason);
    });

    const timeout = init?.timeout ?? 15000;
    const timeoutId =
      timeout > 0
        ? setTimeout(() => {
            abortController.abort(new Error("request timeout"));
          }, timeout)
        : undefined;

    const res = await globalThis
      .fetch(requestUrl, {
        ...init,
        credentials:
          BUILD_CONFIG.isElectron && !sameServer ? "omit" : "include",
        signal: abortController.signal,
        headers: withMyoxusStorageClientContextHeaders({
          ...this.requestHeaders,
          ...init?.headers,
          "x-myoxus-version": BUILD_CONFIG.appVersion,
        }),
      })
      .catch((err) => {
        throw new UserFriendlyError({
          status: 504,
          code: "NETWORK_ERROR",
          type: "NETWORK_ERROR",
          name: "NETWORK_ERROR",
          message: `Network error: ${err.message}`,
          stacktrace: err.stack,
        });
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
    if (!res.ok && res.status !== 404) {
      if (res.status === 413) {
        throw new UserFriendlyError({
          status: 413,
          code: "CONTENT_TOO_LARGE",
          type: "CONTENT_TOO_LARGE",
          name: "CONTENT_TOO_LARGE",
          message: "Content too large",
        });
      } else if (
        res.headers.get("Content-Type")?.startsWith("application/json")
      ) {
        throw UserFriendlyError.fromAny(await res.json());
      } else {
        throw UserFriendlyError.fromAny(await res.text());
      }
    }
    return res;
  };

  readonly fetchArrayBuffer = async (input: string, init?: RequestInit) => {
    const res = await this.fetch(input, init);
    if (res.status === 404) {
      // 404
      return null;
    }
    try {
      return await res.arrayBuffer();
    } catch (err) {
      throw new Error("fetch download error: " + err);
    }
  };

  readonly gql = gqlFetcherFactory(
    new URL("/graphql", this.serverBaseUrl).href,
    this.fetch,
  );

  constructor(
    private readonly serverBaseUrl: string,
    private readonly requestHeaders?: Record<string, string>,
    private readonly serverId?: string,
  ) {
    super();
  }
}
