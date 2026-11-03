// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { appendHoverVariables } from "./runtime-hover-css";
import { appendDocumentForegroundVariables } from "./runtime-document-colors";

export const BRANDING_STYLE_ID = "myoxus-branding-css";
export const THEME_FALLBACK_PATH = "/style/theme-fallback.css";
const PROJECTION_CHANGE_EVENT = "myoxus:theme-projection-changed";

const WORKSPACE_ROUTE_MARKERS = new Set([
  "workspace",
  "public-workspace",
  "share",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THEME_SLUG_PATTERN = /--myoxus-theme-slug\s*:\s*["']?([a-zA-Z0-9_-]+)/;

export type RuntimeThemeProjectionSource =
  "api" | "electron-fallback" | "loading" | "unavailable";

export function normalizeRuntimeSubPath(subPath: string | undefined) {
  if (!subPath || subPath === "/") {
    return "";
  }
  return subPath.replace(/\/+$/, "");
}

export function getThemeFallbackHref(subPath: string | undefined) {
  return `${normalizeRuntimeSubPath(subPath)}${THEME_FALLBACK_PATH}`;
}

export function getBrandingThemeCssHref(
  subPath: string | undefined,
  workspaceId?: string | null,
) {
  const base = normalizeRuntimeSubPath(subPath);
  if (!workspaceId) {
    return `${base}/api/branding/theme.css`;
  }
  return `${base}/api/branding/theme.css?${new URLSearchParams({
    workspaceId,
  }).toString()}`;
}

function safeDecodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function getRuntimeWorkspaceIdFromPathname(
  pathname: string | undefined = globalThis.location?.pathname,
) {
  if (!pathname) {
    return null;
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map(safeDecodePathSegment);
  for (let index = 0; index < segments.length - 1; index += 1) {
    const routeMarker = segments[index];
    if (!routeMarker || !WORKSPACE_ROUTE_MARKERS.has(routeMarker)) {
      continue;
    }
    const workspaceId = segments[index + 1]?.trim();
    return workspaceId && UUID_PATTERN.test(workspaceId) ? workspaceId : null;
  }
  return null;
}

function setProjectionSource(
  doc: Document,
  source: RuntimeThemeProjectionSource,
) {
  doc.documentElement.dataset.myoxusThemeSource = source;
  doc.dispatchEvent(new Event(PROJECTION_CHANGE_EVENT));
}

export function getRuntimeThemeProjectionSource(doc: Document = document) {
  return (doc.documentElement.dataset.myoxusThemeSource ??
    "loading") as RuntimeThemeProjectionSource;
}

/** Observes the live projection, including failure and subsequent recovery. */
export function subscribeRuntimeThemeProjection(
  listener: () => void,
  doc: Document = document,
) {
  doc.addEventListener(PROJECTION_CHANGE_EVENT, listener);
  return () => doc.removeEventListener(PROJECTION_CHANGE_EVENT, listener);
}

export function ensureRuntimeThemeProjectionStyle(doc: Document = document) {
  let style = doc.getElementById(BRANDING_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = BRANDING_STYLE_ID;
    style.dataset.myoxusBranding = "true";
    doc.head.append(style);
  }
  if (!style.dataset.myoxusBrandingSource) {
    style.dataset.myoxusBrandingSource = "loading";
    setProjectionSource(doc, "loading");
  }
  return style;
}

export function applyRuntimeThemeProjection(
  doc: Document,
  css: string,
  source: Exclude<RuntimeThemeProjectionSource, "loading" | "unavailable">,
) {
  const style = ensureRuntimeThemeProjectionStyle(doc);
  style.dataset.myoxusBrandingSource = source;
  style.textContent = appendDocumentForegroundVariables(
    appendHoverVariables(css),
  );
  setProjectionSource(doc, source);
  return style;
}

export function clearRuntimeThemeProjection(doc: Document = document) {
  const style = ensureRuntimeThemeProjectionStyle(doc);
  style.dataset.myoxusBrandingSource = "unavailable";
  style.textContent = "";
  setProjectionSource(doc, "unavailable");
  return style;
}

export function readProjectedThemeSlug(css: string) {
  return THEME_SLUG_PATTERN.exec(css)?.[1] ?? null;
}

export async function fetchRuntimeThemeCss(
  href: string,
  retryDelaysMs: readonly number[] = [],
): Promise<
  | { css: string; status: number; error?: never }
  | { css: null; status: number; error?: never }
  | { css: null; status: null; error: unknown }
> {
  let lastNetworkError: unknown = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetch(href, { cache: "no-cache" });
      if (!response.ok) {
        return { css: null, status: response.status };
      }
      return { css: await response.text(), status: response.status };
    } catch (error) {
      lastNetworkError = error;
      const retryDelay = retryDelaysMs[attempt];
      if (retryDelay === undefined) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  return { css: null, status: null, error: lastNetworkError };
}
