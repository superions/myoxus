/**
 * Global setup for the Myoxus web frontend.
 *
 * Imported as the very first side-effect in `index.tsx` (before React mounts).
 * Runs in order:
 * 1. `@myoxus/core/bootstrap/browser` — browser-specific polyfills and global
 *    configuration (e.g. platform detection, global error handlers).
 * 2. `@myoxus/core/bootstrap/cleanup` — registers cleanup handlers for
 *    resources that must be torn down on page unload.
 * 3. `@myoxus/theme/client.css` — injects the theme-independent editor and
 *    design-system base.
 * 4. The live server theme projection is injected before React mounts. Browser
 *    Web deliberately has no static theme fallback.
 */
import "@myoxus/core/bootstrap/browser";
import "@myoxus/core/bootstrap/cleanup";
import "@myoxus/theme/client.css";

import { configureMyoxusGraphQLClientContext } from "@myoxus/core/modules/server";
import { applyBrandIdentityDocumentMetadata } from "@myoxus/ui-facade";

import { startClientUpdateCompletionCoordinator } from "./client-update/completion";
import {
  clientUpdateGate,
  startClientUpdateCoordinator,
} from "./client-update/coordinator";
import {
  ensureRuntimeThemeProjection,
  startThemeAutoReload,
} from "./runtime-theme";
import {
  createControllerReloadCoordinator,
  readServiceWorkerBuildId,
  updateServiceWorkerRegistration,
} from "./service-worker-update";

configureMyoxusGraphQLClientContext({ client: "web" });
ensureRuntimeThemeProjection();
applyBrandIdentityDocumentMetadata().catch((err) => {
  console.debug?.("[brand-identity] metadata fallback unavailable", err);
});
startThemeAutoReload();
const stopClientUpdateCoordinator = startClientUpdateCoordinator();
const serviceWorkers =
  "serviceWorker" in navigator ? navigator.serviceWorker : null;
const controllerReload = createControllerReloadCoordinator({
  controlledAtStartup: serviceWorkers?.controller != null,
  visibilityState: () => document.visibilityState,
  reload: () => window.location.reload(),
  addVisibilityChangeListener: (listener) => {
    document.addEventListener("visibilitychange", listener);
  },
  removeVisibilityChangeListener: (listener) => {
    document.removeEventListener("visibilitychange", listener);
  },
});
controllerReload.setReloadBlocked(true);
const stopCompletionCoordinator = startClientUpdateCompletionCoordinator({
  source: clientUpdateGate,
  endpoint: window.location.origin,
  reload: controllerReload,
  updateServiceWorker: (requiredBuildId) =>
    updateServiceWorkerRegistration(serviceWorkers, requiredBuildId),
  getCurrentBuildId: () =>
    readServiceWorkerBuildId(serviceWorkers?.controller ?? null),
});

window.addEventListener(
  "pagehide",
  () => {
    stopCompletionCoordinator();
    stopClientUpdateCoordinator();
    controllerReload.dispose();
  },
  {
    once: true,
  },
);

if (serviceWorkers) {
  serviceWorkers.addEventListener(
    "controllerchange",
    controllerReload.controllerChanged,
  );

  window.addEventListener("load", async () => {
    try {
      const registration = await serviceWorkers.register("/sw.js", {
        updateViaCache: "none",
      });
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          void registration.update();
        }
      });
    } catch (error) {
      console.warn("Service worker registration failed:", error);
    }
  });
}
