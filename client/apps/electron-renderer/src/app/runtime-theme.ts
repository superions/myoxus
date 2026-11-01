// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import {
  desktopServerRequestUrl,
  type TabStatus,
} from "@myoxus/desktop-api-contract";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import {
  applyBrandIdentityDocumentMetadata,
  notifyBrandIdentityUpdated,
  setBrandIdentityServerPath,
} from "@myoxus/ui-facade";
import {
  applyRuntimeThemeProjection,
  ensureRuntimeThemeProjectionStyle,
  getBrandingThemeCssHref,
  getRuntimeWorkspaceIdFromPathname,
  readProjectedThemeSlug,
} from "@myoxus/theme";

export type ElectronThemeContext = {
  serverId: string | null;
  workspaceId?: string | null;
};
const hintKey = ({ serverId, workspaceId }: ElectronThemeContext) =>
  `myoxus:electron-theme:${encodeURIComponent(serverId ?? "")}:${encodeURIComponent(workspaceId ?? "global")}`;

/** One in-memory projection per frame. The generated HTML stylesheet owns
 * first paint/offline tokens; only a slug hint is persisted, never server CSS.
 * Changing owners synchronously removes the old projection before fetching. */
export function createRuntimeThemeController(doc: Document = document) {
  let context: ElectronThemeContext = { serverId: null, workspaceId: null };
  let request: AbortController | undefined;
  let disposed = false;
  const style = ensureRuntimeThemeProjectionStyle(doc);

  const showFallback = () => {
    style.textContent = "";
    style.dataset.myoxusBrandingSource = "electron-fallback";
    doc.documentElement.dataset.myoxusThemeSource = "electron-fallback";
    delete doc.documentElement.dataset.myoxusTheme;
    if (!context.serverId) return;
    try {
      const slug = doc.defaultView?.localStorage.getItem(hintKey(context));
      if (slug && /^[a-zA-Z0-9_-]+$/.test(slug))
        doc.documentElement.dataset.myoxusTheme = slug;
    } catch {
      // Storage is optional: the generated catalog still provides its default.
    }
  };

  const reload = async () => {
    request?.abort();
    const currentRequest = (request = new AbortController());
    const current = context;
    if (disposed) return;
    if (!current.serverId) {
      showFallback();
      return;
    }
    try {
      const response = await fetch(
        desktopServerRequestUrl(
          current.serverId,
          getBrandingThemeCssHref(undefined, current.workspaceId),
        ),
        {
          cache: "no-cache",
          signal: currentRequest.signal,
        },
      );
      if (!response.ok) {
        if (!currentRequest.signal.aborted) showFallback();
        return;
      }
      const css = await response.text();
      if (currentRequest.signal.aborted || disposed) return;
      if (!css.trim()) {
        showFallback();
        return;
      }
      const slug = readProjectedThemeSlug(css);
      if (slug) {
        try {
          doc.defaultView?.localStorage.setItem(hintKey(current), slug);
        } catch {
          // A non-authoritative slug hint must never block the API projection.
        }
      }
      // Server-generated font/branding URLs need the same owner as the CSS;
      // otherwise /api/fonts would silently resolve to bundled offline assets.
      const scopedCss = css.replace(
        /url\(\s*(["']?)(\/api\/[^\s)"']+)\1\s*\)/g,
        (_match, _quote, path: string) =>
          `url("${desktopServerRequestUrl(current.serverId!, path)}")`,
      );
      delete doc.documentElement.dataset.myoxusTheme;
      applyRuntimeThemeProjection(doc, scopedCss, "api");
    } catch (error) {
      if (!currentRequest.signal.aborted) {
        showFallback();
        console.debug(
          "[runtime-theme] registered server unavailable; using generated fallback",
          error instanceof Error ? error.name : "NetworkError",
        );
      }
    }
  };

  showFallback();
  return {
    style,
    update(next: ElectronThemeContext) {
      if (
        disposed ||
        (context.serverId === next.serverId &&
          context.workspaceId === (next.workspaceId ?? null))
      )
        return Promise.resolve();
      context = {
        serverId: next.serverId,
        workspaceId: next.workspaceId ?? null,
      };
      showFallback();
      return reload();
    },
    reload,
    dispose() {
      disposed = true;
      request?.abort();
    },
  };
}

/** App frames follow their own tab; persistent shell/popups follow the active
 * tab. The shared Main status is the only handoff, not a second server lookup.
 * Subscribe before reading the snapshot so an old IPC reply cannot win a race. */
export function startThemeAutoReload(frame: "app" | "active") {
  const bridge = getDesktopBridge();
  const controller = createRuntimeThemeController();
  let brandingServer: string | null = null;
  setBrandIdentityServerPath(null);
  const refreshBranding = () => {
    void applyBrandIdentityDocumentMetadata().catch(console.error);
  };
  refreshBranding();
  let observedEvent = false;
  let disposed = false;
  const update = (tabs: TabStatus[]) => {
    const tab =
      frame === "app"
        ? tabs.find((tab) => tab.id === bridge?.appInfo.viewId)
        : tabs.find((tab) => tab.active);
    const serverId = tab?.serverId ?? null;
    if (brandingServer !== serverId) {
      brandingServer = serverId;
      setBrandIdentityServerPath(
        serverId ? `/_server/${encodeURIComponent(serverId)}` : null,
      );
      refreshBranding();
    }
    void controller.update({
      serverId,
      workspaceId: getRuntimeWorkspaceIdFromPathname(tab?.basename ?? ""),
    });
  };
  const unsubscribe = bridge?.events.ui.onTabsStatusChange((tabs) => {
    observedEvent = true;
    if (!disposed) update(tabs);
  });
  void bridge?.apis.ui
    .getTabsStatus()
    .then((tabs) => {
      if (!disposed && !observedEvent) update(tabs);
    })
    .catch(() => {
      /* The generated fallback remains the first-paint owner. */
    });
  const reloadBranding = () => {
    void controller.reload();
    notifyBrandIdentityUpdated();
    refreshBranding();
  };
  const unsubscribeBranding = bridge?.events.ui.onBrandingUpdated(
    ({ serverId }) => {
      if (!disposed && serverId === brandingServer) reloadBranding();
    },
  );
  const onVisibility = () => {
    if (document.visibilityState === "visible") void controller.reload();
  };
  document.addEventListener("visibilitychange", onVisibility);
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel("myoxus-branding");
    channel.onmessage = (event) => {
      if (event.data === "branding-updated") {
        // Only the owning app relays origin-local changes. Main events never
        // post to BroadcastChannel, so persistent frames cannot form a loop.
        if (frame === "app" && bridge) {
          void bridge.apis.ui.invalidateBranding().catch(console.error);
        } else if (!bridge) reloadBranding();
      }
    };
  } catch {
    /* BroadcastChannel is optional; tab context changes still reload. */
  }
  return () => {
    disposed = true;
    unsubscribe?.();
    unsubscribeBranding?.();
    channel?.close();
    document.removeEventListener("visibilitychange", onVisibility);
    controller.dispose();
  };
}
