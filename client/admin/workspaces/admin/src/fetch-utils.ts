// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Central HTTP transport boundary for the admin frontend.
 *
 * Every Admin HTTP exception and the Admin GraphQL fetcher pass through this
 * file. It is intentionally small: page modules may decide what to render, but
 * version headers, CSRF, credentials, auth invalidation and diagnostic logging
 * must not drift per page.
 */
import { DebugLogger } from "@myoxus/debug";

import {
  type AdminSessionInvalidationReason,
  type AdminTransportChannel,
  invalidateAdminSession,
} from "./admin-session";

const CSRF_COOKIE_NAME = "myoxus_csrf_token";
const logger = new DebugLogger("AdminTransport");
const latestRequestDiagnostics = new Map<string, AdminRequestDiagnostic>();

export interface AdminRequestDiagnostic {
  operationName: string;
  correlationId: string | null;
  status: number | null;
  frontendVersion: string;
}

export function getAdminRequestDiagnostic(
  operationName: string,
): AdminRequestDiagnostic | undefined {
  return latestRequestDiagnostics.get(operationName);
}

function recordRequestDiagnostic(
  operationName: string | undefined,
  response?: Response,
) {
  if (!operationName) return;
  latestRequestDiagnostics.set(operationName, {
    operationName,
    correlationId: response?.headers.get("x-request-id") ?? null,
    status: response?.status ?? null,
    frontendVersion: getAppVersion(),
  });
}

type BuildConfigGlobal = typeof globalThis & {
  BUILD_CONFIG?: { appVersion?: string };
};

export type AdminFetchInit = RequestInit & {
  admin?: {
    channel?: AdminTransportChannel;
    operationName?: string;
    invalidateOnAuthFailure?: boolean;
  };
};

/** Reads a single cookie value by name from `document.cookie`, or `null` if not present. */
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

function getAppVersion() {
  return (
    (globalThis as BuildConfigGlobal).BUILD_CONFIG?.appVersion ?? "unknown"
  );
}

function requestMethod(init?: RequestInit) {
  return init?.method?.toUpperCase() ?? "GET";
}

function shouldAttachCsrf(method: string) {
  return method !== "GET" && method !== "HEAD";
}

function targetForLog(input: RequestInfo | URL) {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const base =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://admin.myoxus.local";

  try {
    const url = new URL(raw, base);
    const searchKeys = [...url.searchParams.keys()].sort();
    if (!searchKeys.length) {
      return url.pathname;
    }
    return `${url.pathname}?${searchKeys.map((key) => `${key}=<redacted>`).join("&")}`;
  } catch {
    return "<unparseable-admin-url>";
  }
}

function operationFromHeaders(headers: Headers) {
  return headers.get("x-operation-name") ?? undefined;
}

function inferChannel(path: string): AdminTransportChannel {
  if (path.includes("/graphql")) return "graphql";
  if (path.includes("/api/auth/")) return "auth";
  if (path.includes("/api/setup/")) return "setup";
  if (path.includes("/api/branding/theme.css")) return "runtime-theme";
  if (path.includes("/health")) return "health";
  return "technical-http";
}

function headersWithAdminDefaults(init?: RequestInit) {
  const method = requestMethod(init);
  const headers = new Headers(init?.headers);
  headers.set("x-myoxus-version", getAppVersion());

  const csrfToken = shouldAttachCsrf(method)
    ? getCookieValue(CSRF_COOKIE_NAME)
    : null;
  if (csrfToken && !headers.has("x-myoxus-csrf-token")) {
    headers.set("x-myoxus-csrf-token", csrfToken);
  }

  return headers;
}

function authReasonForStatus(status: number): AdminSessionInvalidationReason {
  return status === 401 ? "rest-unauthorized" : "session-expired";
}

function isAuthStatus(status: number) {
  return status === 401 || status === 403;
}

function isGraphQLAuthErrorPayload(payload: unknown) {
  const errors = (payload as { errors?: unknown })?.errors;
  if (!Array.isArray(errors)) return false;

  return errors.some((entry) => {
    const error = entry as {
      message?: unknown;
      extensions?: Record<string, unknown>;
    };
    const message = typeof error.message === "string" ? error.message : "";
    const extensions = error.extensions ?? {};
    const status = extensions.status;
    const code = String(
      extensions.code ?? extensions.name ?? extensions.type ?? "",
    );
    return (
      status === 401 ||
      status === 403 ||
      // This is the external IdP's credential failure, not the Admin session.
      // Real transport/status auth failures above and other payload errors stay
      // authoritative, including a mixed domain + session error response.
      (code !== "OIDC_GROUP_DIRECTORY_ACCESS_DENIED" &&
        (/unauth|forbidden|not authorized|permission/i.test(message) ||
          /unauth|forbidden|permission|access_denied/i.test(code)))
    );
  });
}

async function inspectAuthFailure(
  response: Response,
  context: {
    channel: AdminTransportChannel;
    operationName?: string;
    source: string;
    invalidateOnAuthFailure: boolean;
  },
) {
  if (!context.invalidateOnAuthFailure) return;

  if (isAuthStatus(response.status)) {
    invalidateAdminSession({
      reason:
        context.channel === "graphql"
          ? "graphql-unauthorized"
          : authReasonForStatus(response.status),
      channel: context.channel,
      operationName: context.operationName,
      source: context.source,
      status: response.status,
    });
    return;
  }

  if (context.channel !== "graphql") return;
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    return;
  }

  try {
    const payload = await response.clone().json();
    if (isGraphQLAuthErrorPayload(payload)) {
      invalidateAdminSession({
        reason: "graphql-unauthorized",
        channel: context.channel,
        operationName: context.operationName,
        source: context.source,
        status: response.status,
      });
    }
  } catch {
    // The real response body must remain available to the caller; clone parse
    // failures are only diagnostic and are intentionally ignored here.
  }
}

/**
 * Admin transport wrapper used by GraphQL and all remaining HTTP exceptions.
 * It returns the original `Response`; callers keep ownership of domain parsing.
 */
export const adminFetch = async (
  input: RequestInfo | URL,
  init?: AdminFetchInit,
): Promise<Response> => {
  const method = requestMethod(init);
  const headers = headersWithAdminDefaults(init);
  const source = targetForLog(input);
  const channel = init?.admin?.channel ?? inferChannel(source);
  const operationName =
    init?.admin?.operationName ?? operationFromHeaders(headers);
  const startedAt = performance.now();
  const requestInit = { ...init };
  delete requestInit.admin;

  try {
    const response = await fetch(input, {
      ...requestInit,
      credentials: requestInit.credentials ?? "include",
      headers,
    });
    const durationMs = Math.round(performance.now() - startedAt);
    recordRequestDiagnostic(operationName, response);

    if (response.ok) {
      logger.debug("admin request completed", {
        channel,
        operationName,
        method,
        source,
        status: response.status,
        durationMs,
      });
    } else {
      logger.warn("admin request failed", {
        channel,
        operationName,
        method,
        source,
        status: response.status,
        durationMs,
      });
    }

    await inspectAuthFailure(response, {
      channel,
      operationName,
      source,
      invalidateOnAuthFailure: init?.admin?.invalidateOnAuthFailure !== false,
    });

    return response;
  } catch (err) {
    recordRequestDiagnostic(operationName);
    logger.warn("admin request transport error", {
      channel,
      operationName,
      method,
      source,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
