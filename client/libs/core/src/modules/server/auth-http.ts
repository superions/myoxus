// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

const CSRF_COOKIE_NAME = "myoxus_csrf_token";

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;
type BuildConfigGlobal = typeof globalThis & {
  BUILD_CONFIG?: { appVersion?: string };
};

function getCookieValue(name: string) {
  if (typeof document === "undefined") {
    return null;
  }

  const cookies = document.cookie ? document.cookie.split("; ") : [];
  for (const cookie of cookies) {
    const idx = cookie.indexOf("=");
    const key = idx === -1 ? cookie : cookie.slice(0, idx);
    if (key === name) {
      return idx === -1 ? "" : cookie.slice(idx + 1);
    }
  }
  return null;
}

function appVersionHeader() {
  return (
    (globalThis as BuildConfigGlobal).BUILD_CONFIG?.appVersion ?? "unknown"
  );
}

/**
 * Shared browser-side sign-out request for Web/Core auth flows.
 *
 * This is intentionally not an Admin adapter: it runs before the shared OAuth
 * handoff as well as in normal account sign-out. It centralizes the wire-level
 * CSRF/version contract so loaders do not grow raw `fetch` callsites again.
 */
export function signOutSharedAuthSession(
  fetchImpl: AuthFetch = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const headers: Record<string, string> = {
    "x-myoxus-version": appVersionHeader(),
  };

  const csrfToken = getCookieValue(CSRF_COOKIE_NAME);
  if (csrfToken) {
    headers["x-myoxus-csrf-token"] = csrfToken;
  }

  return fetchImpl("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers,
  });
}
