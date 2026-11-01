// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { signOutSharedAuthSession } from "../auth-http";

function expireCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; path=/`;
}

describe("shared auth HTTP helpers", () => {
  beforeEach(() => {
    (globalThis as { BUILD_CONFIG?: { appVersion?: string } }).BUILD_CONFIG = {
      appVersion: "0.30.0-test",
    };
    expireCookie("myoxus_csrf_token");
    expireCookie("affine_csrf_token");
  });

  afterEach(() => {
    expireCookie("myoxus_csrf_token");
    expireCookie("affine_csrf_token");
    vi.restoreAllMocks();
  });

  test("sign-out forwards CSRF, version and credentials through one shared helper", async () => {
    document.cookie = "myoxus_csrf_token=csrf-test; path=/";
    document.cookie = "affine_csrf_token=retired-token; path=/";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await signOutSharedAuthSession(fetchMock);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe("/api/auth/sign-out");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers).not.toBeInstanceOf(Headers);
    expect(headers.get("x-myoxus-version")).toBe("0.30.0-test");
    expect(headers.get("x-myoxus-csrf-token")).toBe("csrf-test");
  });

  test("sign-out omits CSRF only when the wire cookie is absent", async () => {
    document.cookie = "affine_csrf_token=retired-token; path=/";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await signOutSharedAuthSession(fetchMock);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("x-myoxus-csrf-token")).toBe(false);
    expect(headers.get("x-myoxus-version")).toBe("0.30.0-test");
  });
});
