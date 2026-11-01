// SPDX-License-Identifier: AGPL-3.0-or-later

import { Framework } from "@myoxus/infra";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FetchService } from "./fetch";
import { ServerService } from "./server";

describe("FetchService", () => {
  const originalBuildConfig = (globalThis as { BUILD_CONFIG?: unknown })
    .BUILD_CONFIG;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    (globalThis as { BUILD_CONFIG?: { appVersion: string } }).BUILD_CONFIG = {
      appVersion: "0.0.0-test",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalBuildConfig === undefined) {
      delete (globalThis as { BUILD_CONFIG?: unknown }).BUILD_CONFIG;
    } else {
      (globalThis as { BUILD_CONFIG?: unknown }).BUILD_CONFIG =
        originalBuildConfig;
    }
    globalThis.fetch = originalFetch;
  });

  function createService() {
    const framework = new Framework();
    framework.service(ServerService, {
      server: {
        baseUrl: "http://example.test",
      },
    } as any);
    framework.service(FetchService, [ServerService]);
    return framework.provider().get(FetchService);
  }

  test("arms the default timeout instead of aborting default requests immediately", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    globalThis.fetch = vi.fn(async () => new Response("{}")) as typeof fetch;

    await createService().fetch("/api/auth/preflight");

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15000);
  });

  test("returns non-ok responses when caller explicitly owns status handling", async () => {
    const fetchMock = vi.fn(
      async () => new Response("disabled", { status: 503 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const response = await createService().fetch("/api/auth/challenge", {
      throwOnHttpError: false,
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("disabled");
  });

  test("preserves Headers instances when adding the Myoxus version header", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    globalThis.fetch = fetchMock as typeof fetch;

    await createService().fetch("/graphql", {
      headers: new Headers({
        "content-type": "application/json",
        "x-myoxus-client-format": "myoxus-native",
      }),
      method: "POST",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init = {}] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit | undefined,
    ];
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-myoxus-client-format")).toBe("myoxus-native");
    expect(headers.get("x-myoxus-version")).toBe("0.0.0-test");
  });
});
