// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ROUTES } from "@myoxus/routes";

export const ADMIN_AUTH_CONTEXT = "admin";

function isAdminPathname(pathname: string) {
  return (
    pathname === ROUTES.admin.index ||
    pathname.startsWith(`${ROUTES.admin.index}/`)
  );
}

function startsWithEncodedSlash(value: string) {
  return /^\/(?:%2f|%5c)/i.test(value);
}

function sanitizeAdminRedirectUri(redirectUri: string) {
  if (
    !redirectUri.startsWith("/") ||
    redirectUri.startsWith("//") ||
    redirectUri.startsWith("/\\") ||
    redirectUri.includes("\\") ||
    startsWithEncodedSlash(redirectUri)
  ) {
    return ROUTES.admin.index;
  }

  try {
    const base = new URL("https://admin.myoxus.local");
    const parsed = new URL(redirectUri, base);
    if (parsed.origin !== base.origin || !isAdminPathname(parsed.pathname)) {
      return ROUTES.admin.index;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return ROUTES.admin.index;
  }
}

export function buildAdminSignInUrl(redirectUri = ROUTES.admin.index) {
  const params = new URLSearchParams();
  params.set("redirect_uri", sanitizeAdminRedirectUri(redirectUri));
  params.set("auth_context", ADMIN_AUTH_CONTEXT);
  return `/sign-in?${params.toString()}`;
}
