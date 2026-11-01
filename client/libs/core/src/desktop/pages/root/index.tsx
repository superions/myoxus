/**
 * RootWrapper — application shell rendered below the router but above all page
 * components.
 *
 * Responsibilities:
 * - Opens the existing connection flow when no configured server exists.
 *   Restored servers use their persisted handshake and revalidate in the
 *   background, so native offline startup is not gated on the network.
 * - Scopes all children inside the default server's `FrameworkScope` so that
 *   server-specific services (e.g. `AuthService`, `ServerService`) are
 *   resolvable without an explicit scope prop at every call site.
 * - Mounts global UI fixtures that exist outside the per-page layout:
 *   `GlobalDialogs` (workspace/settings/confirm dialogs) and — on Electron
 *   only — the `FindInPagePopup`. Transient notifications are rendered
 *   through the Mantine notification portal mounted once inside
 *   `MyoxusUIProvider`, so the per-root toaster mount is gone.
 * - Renders the `<Outlet>` from React Router, which shows the currently active
 *   child route.
 */
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { DefaultServerService } from "@myoxus/core/modules/server";
import {
  FrameworkScope,
  useLiveData,
  useService,
  useServiceOptional,
} from "@myoxus/infra";
import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";

import { GlobalDialogs } from "../../dialogs/global";
import { FindInPagePopup } from "./find-in-page/find-in-page-popup";

/**
 * Top-level application shell component.
 *
 * The root owns the selected-server scope, not server discovery or a synthetic
 * default endpoint. Workspace routes establish their own explicit server
 * scopes below this boundary. Cancellation stops the root's revalidation wait
 * when the selected server changes.
 */
export const RootWrapper = () => {
  const defaultServerService = useService(DefaultServerService);
  const server = useLiveData(defaultServerService.server$);
  const desktopApi = useServiceOptional(DesktopApiService);
  const location = useLocation();

  useEffect(() => {
    if (!server) {
      // The connection form is a usable first-launch screen. Release Main's
      // loading shell even though no workspace layout can be mounted yet.
      desktopApi?.handler.ui.pingAppLayoutReady().catch(console.error);
      return;
    }
    const abortController = new AbortController();
    server
      .waitForConfigRevalidation(abortController.signal)
      .catch(console.error);
    return () => abortController.abort();
  }, [server, desktopApi]);

  if (!server) {
    // Keep the established auth route across successful registration; mounting
    // the index here would otherwise discard the newly opened sign-in step.
    return location.pathname.toLowerCase() === "/sign-in" ? (
      <Outlet />
    ) : (
      <Navigate
        to={`/sign-in?redirect_uri=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  }

  return (
    <FrameworkScope scope={server.scope}>
      <GlobalDialogs />
      <Outlet />
      {BUILD_CONFIG.isElectron && <FindInPagePopup />}
    </FrameworkScope>
  );
};
