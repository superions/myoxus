import { MyoxusContext } from "@myoxus/core/components/context";
import { Telemetry } from "@myoxus/core/components/telemetry";
import { router } from "@myoxus/core/desktop/router";
import { I18nProvider } from "@myoxus/core/modules/i18n";
import { FrameworkRoot, getCurrentStore } from "@myoxus/infra";
import { Suspense, useEffect } from "react";
import { RouterProvider } from "react-router/dom";

import { WindowsAppControls } from "../windows-app-controls";
import { setupEffects, useIsOnBattery } from "./effects";
import { DesktopLanguageSync } from "./language-sync";
import { DesktopThemeSync } from "./theme-sync";
import { DesktopRuntimeServerSync } from "./runtime-server-sync";

const { frameworkProvider } = setupEffects();

const desktopWhiteList = [
  "/open-app/signin-redirect",
  "/open-app/url",
  "/share",
  "/oauth",
  "/magic-link",
];
if (
  !BUILD_CONFIG.isElectron &&
  BUILD_CONFIG.debug &&
  desktopWhiteList.every((path) => !location.pathname.startsWith(path))
) {
  document.body.innerHTML = `<h1 style="color:red;font-size:5rem;text-align:center;">Don't run electron entry in browser.</h1>`;
  throw new Error("Wrong distribution");
}

export function App() {
  const isOnBattery = useIsOnBattery();

  useEffect(() => {
    document.body.classList.toggle("on-battery", isOnBattery);
    return () => {
      document.body.classList.remove("on-battery");
    };
  }, [isOnBattery]);

  return (
    <Suspense>
      <FrameworkRoot framework={frameworkProvider}>
        <Telemetry />
        <DesktopRuntimeServerSync />
        <I18nProvider>
          <MyoxusContext store={getCurrentStore()}>
            <DesktopThemeSync />
            <DesktopLanguageSync />
            <RouterProvider router={router} />
            {environment.isWindows && <WindowsAppControls />}
          </MyoxusContext>
        </I18nProvider>
      </FrameworkRoot>
    </Suspense>
  );
}
