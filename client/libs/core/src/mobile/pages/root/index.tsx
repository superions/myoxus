/**
 * RootWrapper — mobile application shell.
 *
 * The transient-notification portal now lives inside `MyoxusUIProvider`
 * (mounted by the app entry), so the per-root `MyoxusToaster` mount has
 * been removed. We only need `GlobalDialogs` and the React Router
 * `<Outlet />` here.
 */
import { DefaultServerService } from "@myoxus/core/modules/server";
import { FrameworkScope, useService } from "@myoxus/infra";
import { useEffect, useState } from "react";
import { Outlet } from "react-router";

import { GlobalDialogs } from "../../dialogs";

export const RootWrapper = () => {
  const defaultServerService = useService(DefaultServerService);
  const [isServerReady, setIsServerReady] = useState(false);

  useEffect(() => {
    if (isServerReady) {
      return;
    }
    const abortController = new AbortController();
    defaultServerService.server
      .waitForConfigRevalidation(abortController.signal)
      .then(() => setIsServerReady(true))
      .catch(console.error);
    return () => abortController.abort();
  }, [defaultServerService, isServerReady]);

  return (
    <FrameworkScope scope={defaultServerService.server.scope}>
      <GlobalDialogs />
      <Outlet />
    </FrameworkScope>
  );
};
