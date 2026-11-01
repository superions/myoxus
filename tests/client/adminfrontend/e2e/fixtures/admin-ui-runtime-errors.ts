// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { expect, type Page, type Request } from "@playwright/test";

export interface AdminRuntimeError {
  source: "console" | "pageerror" | "requestfailed";
  message: string;
  url?: string;
}

export interface AdminRuntimeErrorCollector {
  readonly errors: AdminRuntimeError[];
  assertNoFatal: () => void;
}

const FATAL_MESSAGE_PATTERNS = [
  /\bReferenceError\b/i,
  /\bHydration (?:failed|error)\b/i,
  /\bReact (?:render|recoverable) error\b/i,
  /\bChunkLoadError\b/i,
  /\bSourceMap.*(?:failed|error)\b/i,
  /\bCSS .*failed\b/i,
  /\bfont .*failed\b/i,
  /\bindex error, retry in 5s\b/i,
  /\bWorker-Retry\b/i,
  /\binvalid (?:category|doc_id)\b/i,
  /\bunhandled (?:promise )?rejection\b/i,
];

const TYPE_ERROR_ALLOWLIST = [
  // Playwright can stringify aborted browser internals as TypeError. Product
  // bundle TypeErrors still fail because they include a file/stack message.
  /^TypeError: Load failed$/i,
];

function isAllowedTypeError(message: string): boolean {
  return TYPE_ERROR_ALLOWLIST.some((pattern) => pattern.test(message.trim()));
}

export function matchesAdminRuntimeFatal(message: string): boolean {
  if (/\bTypeError\b/i.test(message) && !isAllowedTypeError(message)) {
    return true;
  }
  return FATAL_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function formatAdminRuntimeErrors(errors: readonly AdminRuntimeError[]) {
  return errors
    .map((error) => {
      const location = error.url ? ` ${error.url}` : "";
      return `[${error.source}]${location} ${error.message}`;
    })
    .join("\n");
}

function requestLooksLikeCriticalAdminAsset(request: Request): boolean {
  const url = request.url();
  return /\.(?:css|js|mjs|woff2?|ttf|otf)(?:\?|$)/i.test(url);
}

function isBenignFontAbort(request: Request, failure: string): boolean {
  try {
    const url = new URL(request.url());
    return (
      url.pathname.startsWith("/api/fonts/") &&
      /net::ERR_ABORTED/i.test(failure)
    );
  } catch {
    return false;
  }
}

export function installAdminRuntimeErrorCollector(
  page: Page,
): AdminRuntimeErrorCollector {
  const errors: AdminRuntimeError[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (matchesAdminRuntimeFatal(text)) {
      errors.push({ source: "console", message: text });
    }
  });

  page.on("pageerror", (error) => {
    const message = error.stack ?? error.message;
    if (matchesAdminRuntimeFatal(message)) {
      errors.push({ source: "pageerror", message });
    }
  });

  page.on("requestfailed", (request) => {
    if (!requestLooksLikeCriticalAdminAsset(request)) return;
    const failure = request.failure()?.errorText ?? "request failed";
    if (isBenignFontAbort(request, failure)) return;
    errors.push({
      source: "requestfailed",
      message: failure,
      url: request.url(),
    });
  });

  return {
    errors,
    assertNoFatal: () => {
      expect(errors, formatAdminRuntimeErrors(errors)).toEqual([]);
    },
  };
}

export async function waitForAdminRuntimeReady(
  page: Page,
  routeAnchor = '[data-testid^="admin-route-"], [data-admin-shell], main',
) {
  await page.waitForLoadState("load");
  await page.waitForSelector(routeAnchor, {
    state: "visible",
    timeout: 15_000,
  });
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.documentElement);
    return Boolean(
      style.getPropertyValue("--myoxus-text-primary-color").trim() ||
      style.getPropertyValue("--myoxus-web-text").trim() ||
      style.getPropertyValue("--foreground").trim(),
    );
  });
}
