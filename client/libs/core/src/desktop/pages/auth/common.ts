/**
 * Shared constants for the auth callback pages (magic-link, OAuth callback).
 *
 * The `supportedClient` schema validates the `client` query parameter that
 * native apps append to auth callback URLs so the web handler knows to build
 * a deep-link and redirect to the native app instead of completing the flow
 * in the browser.
 */
import { z } from "zod";

export const SIGN_IN_PATH = "/sign-in";
export const CLOSE_POPUP_REDIRECT_TARGET = "CLOSE_POPUP";

export type AuthContext = "admin";

/**
 * Zod enum of all client identifiers that auth callback pages recognise.
 *
 * - `web` — complete the flow in the browser (also the default when absent).
 * - `myoxus` / `myoxus-beta` / `myoxus-internal` — redirect via a custom URL
 *   scheme to the corresponding Electron build.
 * - `myoxus-dev` — only available in debug builds.
 */
export const supportedClient = z.enum([
  "web",
  "myoxus",
  "myoxus-beta",
  "myoxus-internal",
  ...(BUILD_CONFIG.debug ? ["myoxus-dev"] : []),
]);

export function parseAuthContext(value: string | null | undefined) {
  return value === "admin" ? value : undefined;
}

/**
 * Admin routes are served by a separate frontend bundle. Auth pages run inside
 * the Web bundle, so returning to `/adminfrontend/*` must replace the document
 * instead of asking the Web React router to render an Admin route.
 */
export function requiresDocumentAuthRedirect(
  value: string | null | undefined,
  origin = defaultOrigin(),
) {
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

function defaultOrigin() {
  if (typeof location !== "undefined") {
    return location.origin;
  }

  return "https://app.myoxus.local";
}

function startsWithEncodedSlash(value: string) {
  return /^\/(?:%2f|%5c)/i.test(value);
}

/**
 * Normalizes an auth redirect target to a same-origin relative URL.
 *
 * The auth flow accepts only app-local paths. Full URLs, protocol-relative
 * URLs, backslash variants, and encoded protocol-relative tricks are rejected.
 * `CLOSE_POPUP` remains an explicit desktop OAuth compatibility target.
 */
export function sanitizeAuthRedirectTarget(
  value: string | null | undefined,
  origin = defaultOrigin(),
) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (trimmed.toUpperCase() === CLOSE_POPUP_REDIRECT_TARGET) {
    return CLOSE_POPUP_REDIRECT_TARGET;
  }

  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\") ||
    startsWithEncodedSlash(trimmed)
  ) {
    return undefined;
  }

  let parsed: URL;
  let base: URL;
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

  if (
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.startsWith("/\\") ||
    startsWithEncodedSlash(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

export function buildSignInUrl({
  error,
  redirectUri,
  authContext,
}: {
  error?: string;
  redirectUri?: string;
  authContext?: AuthContext;
} = {}) {
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
