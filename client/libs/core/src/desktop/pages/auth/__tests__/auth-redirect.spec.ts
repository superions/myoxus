// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  buildSignInUrl,
  CLOSE_POPUP_REDIRECT_TARGET,
  parseAuthContext,
  requiresDocumentAuthRedirect,
  sanitizeAuthRedirectTarget,
} from "../common";

describe("auth redirect helpers", () => {
  const origin = "https://app.myoxus.local";

  test("keeps local relative redirect targets", () => {
    expect(sanitizeAuthRedirectTarget("/adminfrontend", origin)).toBe(
      "/adminfrontend",
    );
    expect(
      sanitizeAuthRedirectTarget("/workspace/1?mode=doc#block-2", origin),
    ).toBe("/workspace/1?mode=doc#block-2");
  });

  test("keeps the desktop popup-close compatibility target", () => {
    expect(sanitizeAuthRedirectTarget("close_popup", origin)).toBe(
      CLOSE_POPUP_REDIRECT_TARGET,
    );
  });

  test("rejects external and protocol-relative redirect targets", () => {
    expect(
      sanitizeAuthRedirectTarget("https://example.invalid", origin),
    ).toBeUndefined();
    expect(
      sanitizeAuthRedirectTarget("//example.invalid", origin),
    ).toBeUndefined();
    expect(
      sanitizeAuthRedirectTarget("/%2f%2fexample.invalid", origin),
    ).toBeUndefined();
    expect(
      sanitizeAuthRedirectTarget("javascript:alert(1)", origin),
    ).toBeUndefined();
    expect(sanitizeAuthRedirectTarget("", origin)).toBeUndefined();
  });

  test("parses only known decorative auth contexts", () => {
    expect(parseAuthContext("admin")).toBe("admin");
    expect(parseAuthContext("owner")).toBeUndefined();
    expect(parseAuthContext(null)).toBeUndefined();
  });

  test("builds sign-in URLs with readable redirect and context query params", () => {
    expect(
      buildSignInUrl({
        redirectUri: "/adminfrontend",
        authContext: "admin",
      }),
    ).toBe("/sign-in?redirect_uri=%2Fadminfrontend&auth_context=admin");
  });

  test("requires document reload when auth returns from web to admin shell", () => {
    expect(requiresDocumentAuthRedirect("/adminfrontend", origin)).toBe(true);
    expect(
      requiresDocumentAuthRedirect("/adminfrontend/git-sync", origin),
    ).toBe(true);
    expect(
      requiresDocumentAuthRedirect(
        "/adminfrontend/git-sync?tab=activity",
        origin,
      ),
    ).toBe(true);
    expect(requiresDocumentAuthRedirect("/workspace/ws-1", origin)).toBe(false);
    expect(requiresDocumentAuthRedirect("/adminfrontendevil", origin)).toBe(
      false,
    );
    expect(
      requiresDocumentAuthRedirect(
        "https://evil.invalid/adminfrontend",
        origin,
      ),
    ).toBe(false);
  });
});
