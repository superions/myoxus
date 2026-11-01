/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  consumeWorkspaceRedirectCookie,
  sanitizeWorkspaceRedirectPath,
} from "./redirect-cookie";

function clearCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; Path=/`;
}

afterEach(() => {
  clearCookie("myoxus_redirect");
  vi.unstubAllGlobals();
});

describe("workspace redirect cookie handoff", () => {
  test("accepts same-origin workspace paths with query and hash", () => {
    expect(
      sanitizeWorkspaceRedirectPath(
        "/workspace/ws-1/all?tab=docs#top",
        "https://myoxus.test",
      ),
    ).toBe("/workspace/ws-1/all?tab=docs#top");
  });

  test("rejects external, protocol-relative, non-workspace and backslash paths", () => {
    const origin = "https://myoxus.test";
    expect(
      sanitizeWorkspaceRedirectPath(
        "https://evil.test/workspace/ws/all",
        origin,
      ),
    ).toBeNull();
    expect(
      sanitizeWorkspaceRedirectPath("//evil.test/workspace/ws/all", origin),
    ).toBeNull();
    expect(
      sanitizeWorkspaceRedirectPath("/adminfrontend/design", origin),
    ).toBeNull();
    expect(sanitizeWorkspaceRedirectPath("/\\evil", origin)).toBeNull();
    expect(
      sanitizeWorkspaceRedirectPath("/workspace\\evil", origin),
    ).toBeNull();
  });

  test("consumes and clears the nginx workspace redirect cookie", () => {
    vi.stubGlobal("location", { origin: "https://myoxus.test" });
    document.cookie =
      "myoxus_redirect=/workspace/ws-1/all%3Ffrom%3Dreload; Path=/";

    expect(consumeWorkspaceRedirectCookie()).toBe(
      "/workspace/ws-1/all?from=reload",
    );
    expect(consumeWorkspaceRedirectCookie()).toBeNull();
  });

  test("clears rejected cookie values as a one-shot handoff", () => {
    vi.stubGlobal("location", { origin: "https://myoxus.test" });
    document.cookie =
      "myoxus_redirect=https%3A%2F%2Fevil.test%2Fworkspace%2Fws%2Fall; Path=/";

    expect(consumeWorkspaceRedirectCookie()).toBeNull();
    expect(consumeWorkspaceRedirectCookie()).toBeNull();
  });
});
