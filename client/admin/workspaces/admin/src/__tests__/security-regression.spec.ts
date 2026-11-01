/**
 * @vitest-environment happy-dom
 */
/**
 * Security regression tests for the admin frontend.
 *
 * These tests document and enforce security-critical behaviors that were
 * fixed in the codebase. They must FAIL if the corresponding fix is reverted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  getAdminSessionSnapshot,
  resetAdminSessionInvalidation,
} from "../admin-session";

describe("CSRF on sign-out", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAdminSessionInvalidation();
    vi.restoreAllMocks();
  });

  test.each([true, false])(
    "adminFetch uses only the Myoxus CSRF cookie on POST (present: %s)",
    async (present) => {
      // Simulate the csrf cookie
      Object.defineProperty(document, "cookie", {
        get: () =>
          `affine_csrf_token=retired-token; ${present ? "myoxus_csrf_token=test-csrf-value; " : ""}affine_session=session-123`,
        configurable: true,
      });

      // Mock BUILD_CONFIG global
      (globalThis as any).BUILD_CONFIG = { appVersion: "0.0.0-test" };

      const fetchSpy = vi
        .fn()
        .mockResolvedValue(new Response("{}", { status: 200 }));
      globalThis.fetch = fetchSpy;

      // Import adminFetch fresh (re-evaluate the module)
      const { adminFetch } = await import("../fetch-utils");

      await adminFetch("/api/auth/sign-out", { method: "POST" });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0];
      expect((init.headers as Headers).get("x-myoxus-csrf-token")).toBe(
        present ? "test-csrf-value" : null,
      );
      expect((init.headers as Headers).get("x-myoxus-version")).toBe(
        "0.0.0-test",
      );
      expect(init.credentials).toBe("include");
    },
  );

  test("adminFetch does NOT attach csrf header on GET requests", async () => {
    Object.defineProperty(document, "cookie", {
      get: () => "myoxus_csrf_token=test-csrf-value",
      configurable: true,
    });
    (globalThis as any).BUILD_CONFIG = { appVersion: "0.0.0-test" };

    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    globalThis.fetch = fetchSpy;

    const { adminFetch } = await import("../fetch-utils");

    await adminFetch("/api/auth/session", { method: "GET" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    expect((init.headers as Headers).get("x-myoxus-csrf-token")).toBeNull();
  });

  test("adminFetch invalidates the admin session on REST 401", async () => {
    (globalThis as any).BUILD_CONFIG = { appVersion: "0.0.0-test" };
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 401 }));
    globalThis.fetch = fetchSpy;

    const { adminFetch } = await import("../fetch-utils");
    await adminFetch("/api/admin/branding/upload");

    const session = getAdminSessionSnapshot();
    expect(session.invalidated).toBe(true);
    expect(session.context?.reason).toBe("rest-unauthorized");
    expect(session.context?.channel).toBe("technical-http");
    expect(session.context?.status).toBe(401);
  });

  test.each(["session", "directory", "mixed"])(
    "adminFetch distinguishes session auth from directory access: %s",
    async (kind) => {
      (globalThis as any).BUILD_CONFIG = { appVersion: "0.0.0-test" };
      const sessionError = {
        message: "Unauthorized",
        extensions: { status: 401, code: "UNAUTHENTICATED" },
      };
      const directoryError = {
        message: "group directory access denied (HTTP 403)",
        extensions: {
          httpStatus: 403,
          code: "OIDC_GROUP_DIRECTORY_ACCESS_DENIED",
        },
      };
      const body = {
        errors:
          kind === "directory"
            ? [directoryError]
            : kind === "mixed"
              ? [directoryError, sessionError]
              : [sessionError],
      };
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      globalThis.fetch = fetchSpy;

      const { adminFetch } = await import("../fetch-utils");
      const response = await adminFetch("/graphql", {
        method: "POST",
        headers: { "x-operation-name": "AdminProbe" },
        body: JSON.stringify({
          query: "query AdminProbe { currentUser { id } }",
        }),
      });

      await expect(response.json()).resolves.toEqual(body);
      const session = getAdminSessionSnapshot();
      expect(session.invalidated).toBe(kind !== "directory");
      if (kind === "directory") return;
      expect(session.context?.reason).toBe("graphql-unauthorized");
      expect(session.context?.channel).toBe("graphql");
      expect(session.context?.operationName).toBe("AdminProbe");
    },
  );

  test("signOutAdminSession invalidates the central admin session on logout", async () => {
    (globalThis as any).BUILD_CONFIG = { appVersion: "0.0.0-test" };
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 204 }));
    globalThis.fetch = fetchSpy;

    const { signOutAdminSession } = await import("../api/auth-session-api");
    await signOutAdminSession("security-regression");

    const session = getAdminSessionSnapshot();
    expect(session.invalidated).toBe(true);
    expect(session.context).toMatchObject({
      reason: "logout",
      channel: "auth",
      operationName: "adminSignOut",
      source: "security-regression",
      status: 204,
    });
  });
});
