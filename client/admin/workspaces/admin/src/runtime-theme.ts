// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import {
  applyRuntimeThemeProjection,
  clearRuntimeThemeProjection,
  ensureRuntimeThemeProjectionStyle,
} from "@myoxus/theme";

import { fetchBrandingThemeCss } from "./api/runtime-status-api";

const runtimeThemeLogKeys = new Set<string>();
let projectionRequestId = 0;

function logRuntimeThemeError(message: string, details?: unknown) {
  if (runtimeThemeLogKeys.has(message)) {
    return;
  }
  runtimeThemeLogKeys.add(message);
  console.error?.(`[runtime-theme] ${message}`, details ?? "");
}

async function injectBrandingCSS(
  doc: Document = document,
  subPath: string | undefined = globalThis.environment?.subPath,
) {
  const requestId = ++projectionRequestId;
  try {
    const css = await fetchBrandingThemeCss(subPath);
    if (requestId !== projectionRequestId) {
      return;
    }
    if (css) {
      applyRuntimeThemeProjection(doc, css, "api");
      return;
    }
    logRuntimeThemeError("branding API unavailable in admin client", {
      fallback: "disabled",
    });
  } catch (error) {
    if (requestId !== projectionRequestId) {
      return;
    }
    logRuntimeThemeError("branding API request failed in admin client", {
      error: error instanceof Error ? error.message : String(error),
      fallback: "disabled",
    });
  }
  clearRuntimeThemeProjection(doc);
}

export function reloadRuntimeTheme(
  doc: Document = document,
  subPath: string | undefined = globalThis.environment?.subPath,
) {
  void injectBrandingCSS(doc, subPath);
}

export function ensureRuntimeThemeProjection(
  doc: Document = document,
  subPath: string | undefined = globalThis.environment?.subPath,
) {
  const style = ensureRuntimeThemeProjectionStyle(doc);
  void injectBrandingCSS(doc, subPath);
  return style;
}
