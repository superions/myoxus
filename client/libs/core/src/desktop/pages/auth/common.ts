// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { z } from "zod";

export const SIGN_IN_PATH = "/sign-in";
export const CLOSE_POPUP_REDIRECT_TARGET = "CLOSE_POPUP";

export type AuthContext = "admin";

export const supportedClient = z.enum([
  "web",
  "myoxus",
  "myoxus-beta",
  "myoxus-internal",
  ...(BUILD_CONFIG.debug ? ["myoxus-dev"] : []),
]);

export function parseAuthContext(
  value: string | null | undefined,
): AuthContext | undefined {
  return value === "admin" ? value : undefined;
}

function defaultOrigin(): string {
  return typeof location !== "undefined"
    ? location.origin
    : "https://app.myoxus.local";
}

function hasEncodedLeadingSlash(value: string): boolean {
  return /^\/(?:%2f|%5c)/i.test(value);
}

function isUnsafeRelativeTarget(value: string): boolean {
  return (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    hasEncodedLeadingSlash(value)
  );
}

/**
 * Restricts post-auth redirects to normalized same-origin relative paths (or
 * the desktop OAuth `CLOSE_POPUP` sentinel).
 */
export function sanitizeAuthRedirectTarget(
  value: string | null | undefined,
  origin = defaultOrigin(),
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toUpperCase() === CLOSE_POPUP_REDIRECT_TARGET) {
    return CLOSE_POPUP_REDIRECT_TARGET;
  }
  if (isUnsafeRelativeTarget(trimmed)) {
    return undefined;
  }

  let base: URL;
  let parsed: URL;
  try {
    base = new URL(origin);
    parsed = new URL(trimmed, base);
  } catch {
    return undefined;
  }

  if (parsed.origin !== base.origin) {
    return undefined;
  }

  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return isUnsafeRelativeTarget(normalized) ? undefined : normalized;
}

/**
 * Returns true when the redirect target belongs to the separately bundled
 * `/adminfrontend` app and therefore requires a full document navigation.
 */
export function requiresDocumentAuthRedirect(
  value: string | null | undefined,
  origin = defaultOrigin(),
): boolean {
  const target = sanitizeAuthRedirectTarget(value, origin);
  if (!target || target === CLOSE_POPUP_REDIRECT_TARGET) {
    return false;
  }
  try {
    const parsed = new URL(target, new URL(origin));
    return (
      parsed.pathname === "/adminfrontend" ||
      parsed.pathname.startsWith("/adminfrontend/")
    );
  } catch {
    return false;
  }
}

export function buildSignInUrl({
  error,
  redirectUri,
  authContext,
}: {
  error?: string;
  redirectUri?: string;
  authContext?: AuthContext;
} = {}): string {
  const params = new URLSearchParams();
  if (error) {
    params.set("error", error);
  }
  if (redirectUri) {
    params.set("redirect_uri", redirectUri);
  }
  if (authContext) {
    params.set("auth_context", authContext);
  }
  const query = params.toString();
  return query ? `${SIGN_IN_PATH}?${query}` : SIGN_IN_PATH;
}
