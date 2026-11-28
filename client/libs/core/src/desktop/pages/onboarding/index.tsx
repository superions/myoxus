// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import { useServiceOptional } from "@myoxus/infra";
import { useCallback } from "react";
import { redirect } from "react-router";

import { appConfigStorage } from "../../../components/hooks/use-app-config-storage";
import { Onboarding } from "../../../components/myoxus/onboarding/onboarding";

export function loader() {
  if (!BUILD_CONFIG.isElectron && !appConfigStorage.get("onBoarding")) {
    return redirect("/");
  }
  return null;
}

export function Component() {
  const desktopApi = useServiceOptional(DesktopApiService);
  const handleOpenApp = useCallback(() => {
    desktopApi?.handler.ui.handleOpenMainApp().catch((error) => {
      console.error("Failed to open main app", error);
    });
  }, [desktopApi]);

  return <Onboarding onOpenApp={handleOpenApp} />;
}
