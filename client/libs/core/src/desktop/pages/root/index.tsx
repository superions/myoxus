// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

export function RootWrapper() {
  const defaultServerService = useService(DefaultServerService);
  const server = useLiveData(defaultServerService.server$);
  const desktopApi = useServiceOptional(DesktopApiService);
  const location = useLocation();

  useEffect(() => {
    if (!server) {
      desktopApi?.handler.ui.pingAppLayoutReady().catch(console.error);
      return;
    }
    const controller = new AbortController();
    server.waitForConfigRevalidation(controller.signal).catch(console.error);
    return () => controller.abort();
  }, [desktopApi, server]);

  if (!server) {
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
      {BUILD_CONFIG.isElectron ? <FindInPagePopup /> : null}
    </FrameworkScope>
  );
}
