// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import {
  applyRuntimeThemeProjection,
  clearRuntimeThemeProjection,
  ensureRuntimeThemeProjectionStyle,
  fetchRuntimeThemeCss,
  getBrandingThemeCssHref,
  getRuntimeWorkspaceIdFromPathname,
} from "./runtime-projection";

export {
  getBrandingThemeCssHref,
  getRuntimeWorkspaceIdFromPathname,
} from "./runtime-projection";

const BRANDING_NETWORK_RETRY_DELAYS_MS = [150, 600] as const;
const runtimeThemeLogKeys = new Set<string>();
const runtimeThemeErrorKeys = new Set<string>();
let projectionRequestId = 0;

function logRuntimeThemeDebug(message: string, details?: unknown) {
  if (runtimeThemeLogKeys.has(message)) {
    return;
  }
  runtimeThemeLogKeys.add(message);
  console.debug?.(`[runtime-theme] ${message}`, details ?? "");
}

function logRuntimeThemeError(message: string, details?: unknown) {
  if (runtimeThemeErrorKeys.has(message)) {
    return;
  }
  runtimeThemeErrorKeys.add(message);
  console.error?.(`[runtime-theme] ${message}`, details ?? "");
}

async function injectBrandingCSS(
  doc: Document = document,
  subPath: string | undefined = globalThis.environment?.subPath,
  workspaceId: string | null | undefined = getRuntimeWorkspaceIdFromPathname(),
) {
  const requestId = ++projectionRequestId;
  const result = await fetchRuntimeThemeCss(
    getBrandingThemeCssHref(subPath, workspaceId),
    BRANDING_NETWORK_RETRY_DELAYS_MS,
  );
  if (requestId !== projectionRequestId) {
    return;
  }
  if (!result.css) {
    const details = {
      error:
        result.error instanceof Error
          ? result.error.message
          : result.error
            ? String(result.error)
            : undefined,
      fallback: "disabled",
      status: result.status,
      workspaceId,
    };
    logRuntimeThemeDebug("branding API unavailable", details);
    logRuntimeThemeError("branding API unavailable in web client", details);
    clearRuntimeThemeProjection(doc);
    return;
  }
  applyRuntimeThemeProjection(doc, result.css, "api");
}

export function reloadRuntimeTheme(
  doc: Document = document,
  subPath: string | undefined = globalThis.environment?.subPath,
  workspaceId: string | null | undefined = getRuntimeWorkspaceIdFromPathname(),
) {
  void injectBrandingCSS(doc, subPath, workspaceId);
}

export function ensureRuntimeThemeProjection(
  doc: Document = document,
  subPath: string | undefined = globalThis.environment?.subPath,
  workspaceId: string | null | undefined = getRuntimeWorkspaceIdFromPathname(),
) {
  const style = ensureRuntimeThemeProjectionStyle(doc);
  void injectBrandingCSS(doc, subPath, workspaceId);
  return style;
}

export function startThemeAutoReload() {
  let lastReload = 0;
  const minReloadIntervalMs = 10_000;
  let lastWorkspaceId = getRuntimeWorkspaceIdFromPathname();

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    const now = Date.now();
    if (now - lastReload < minReloadIntervalMs) {
      return;
    }
    lastReload = now;
    reloadRuntimeTheme();
  };

  document.addEventListener("visibilitychange", onVisibilityChange);

  const reloadOnWorkspaceRouteChange = () => {
    const nextWorkspaceId = getRuntimeWorkspaceIdFromPathname();
    if (nextWorkspaceId === lastWorkspaceId) {
      return;
    }
    lastWorkspaceId = nextWorkspaceId;
    reloadRuntimeTheme();
  };

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  const scheduleRouteReload = () => {
    queueMicrotask(reloadOnWorkspaceRouteChange);
  };
  const patchedPushState: typeof history.pushState = function patchedPushState(
    this: History,
    ...args
  ) {
    const result = originalPushState.apply(this, args);
    scheduleRouteReload();
    return result;
  };
  const patchedReplaceState: typeof history.replaceState =
    function patchedReplaceState(this: History, ...args) {
      const result = originalReplaceState.apply(this, args);
      scheduleRouteReload();
      return result;
    };
  history.pushState = patchedPushState;
  history.replaceState = patchedReplaceState;
  window.addEventListener("popstate", reloadOnWorkspaceRouteChange);

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel("myoxus-branding");
    channel.onmessage = (event) => {
      if (event.data === "branding-updated") {
        reloadRuntimeTheme();
      }
    };
  } catch {
    // Visibility and route listeners remain available in embedded runtimes.
  }

  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("popstate", reloadOnWorkspaceRouteChange);
    if (history.pushState === patchedPushState) {
      history.pushState = originalPushState;
    }
    if (history.replaceState === patchedReplaceState) {
      history.replaceState = originalReplaceState;
    }
    channel?.close();
  };
}
