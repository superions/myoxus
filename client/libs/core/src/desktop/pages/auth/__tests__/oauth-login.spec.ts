// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */
import { OAuthProviderType } from "@myoxus/graphql";
import { createElement, StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { preflightMock } = vi.hoisted(() => ({ preflightMock: vi.fn() }));
vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useService: () => ({ oauthPreflight: preflightMock }),
}));
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useLoaderData: () => ({ provider: OAuthProviderType.Google, client: "web" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../status", () => ({ AuthStatusPage: () => null }));

import { Component, loader } from "../oauth-login";

function expireCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; path=/`;
}

describe("OAuth login loader", () => {
  beforeEach(() => {
    (globalThis as { BUILD_CONFIG?: { appVersion?: string } }).BUILD_CONFIG = {
      appVersion: "0.30.0-test",
    };
    expireCookie("myoxus_csrf_token");
  });

  afterEach(() => {
    cleanup();
    expireCookie("myoxus_csrf_token");
    vi.unstubAllGlobals();
  });

  test("one mounted login owns one preflight even when StrictMode replays effects", async () => {
    preflightMock.mockReset().mockReturnValue(new Promise(() => {}));
    const ui = createElement(StrictMode, null, createElement(Component));
    const mounted = render(ui);
    await waitFor(() =>
      expect(preflightMock).toHaveBeenCalledExactlyOnceWith(
        OAuthProviderType.Google,
        "web",
        undefined,
      ),
    );
    mounted.rerender(createElement(StrictMode, null, createElement(Component)));
    expect(preflightMock).toHaveBeenCalledTimes(1);
  });

  test("web OAuth preflight signs out through the shared auth HTTP contract", async () => {
    document.cookie = "myoxus_csrf_token=csrf-oauth; path=/";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = (await loader({
      request: new Request(
        "https://app.myoxus.local/oauth-login?provider=Google&client=web&redirect_uri=/adminfrontend&auth_context=admin",
      ),
      params: {},
      context: {},
    } as never)) as {
      provider: OAuthProviderType;
      client: string;
      redirectUri?: string;
      authContext?: string;
    };

    expect(result).toMatchObject({
      provider: OAuthProviderType.Google,
      client: "web",
      redirectUri: "/adminfrontend",
      authContext: "admin",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("/api/auth/sign-out");
    expect(init.credentials).toBe("include");
    expect(headers.get("x-myoxus-version")).toBe("0.30.0-test");
    expect(headers.get("x-myoxus-csrf-token")).toBe("csrf-oauth");
  });

  test("native OAuth clients do not perform browser sign-out preflight", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = (await loader({
      request: new Request(
        "https://app.myoxus.local/oauth-login?provider=GitHub&client=myoxus",
      ),
      params: {},
      context: {},
    } as never)) as { provider: OAuthProviderType; client: string };

    expect(result).toMatchObject({
      provider: OAuthProviderType.GitHub,
      client: "myoxus",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
