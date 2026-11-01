/**
 * Root application module for the Myoxus web frontend.
 *
 * Bootstraps the dependency-injection framework, wires the storage worker
 * (SharedWorker when available, falling back to a plain Worker), registers
 * the PopupWindowProvider with origin-safe redirect-proxy logic, and exports
 * the top-level <App> component that mounts the full React tree.
 */
import { MyoxusContext } from "@myoxus/core/components/context";
import { Telemetry } from "@myoxus/core/components/telemetry";
import { router } from "@myoxus/core/desktop/router";
import { I18nProvider } from "@myoxus/core/modules/i18n";
import { LifecycleService } from "@myoxus/core/modules/lifecycle";
import { configureCommonShellModules } from "@myoxus/core/modules/shell";
import {
  configureLocalStorageStateStorageImpls,
  StoreProvider,
} from "@myoxus/core/modules/storage";
import { PopupWindowProvider } from "@myoxus/core/modules/url";
import { configureBrowserWorkbenchModule } from "@myoxus/core/modules/workbench";
import { configureBrowserWorkspaceFlavours } from "@myoxus/core/modules/workspace-engine";
import { registerWorkspaceFeatureLoader } from "@myoxus/core/modules/workspace-feature-loader";
import { getWorkerUrl } from "@myoxus/env/worker";
import { Framework, FrameworkRoot, getCurrentStore } from "@myoxus/infra";
import { OpClient } from "@myoxus/infra/op";
import { StoreManagerClient } from "@myoxus/storage/worker/client";
import { setTelemetryTransport } from "@myoxus/track";
import { Suspense } from "react";
import { RouterProvider } from "react-router/dom";

import { configureClientUpdateCacheResetAdapter } from "./client-update/cache-reset";
import { ClientUpdateSurface } from "./client-update/surface";

let storeManagerClient: StoreManagerClient;

const workerUrl = getWorkerUrl("storage");

// Prefer a SharedWorker so that multiple tabs share a single storage instance.
// Fall back to a dedicated Worker when SharedWorker is unavailable or explicitly
// disabled via localStorage (useful for debugging).
if (
  window.SharedWorker &&
  localStorage.getItem("disableSharedWorker") !== "true"
) {
  const worker = new SharedWorker(workerUrl, {
    name: "myoxus-shared-worker",
  });
  storeManagerClient = new StoreManagerClient(
    new OpClient(worker.port),
    window.location.origin,
  );
} else {
  const worker = new Worker(workerUrl);
  storeManagerClient = new StoreManagerClient(
    new OpClient(worker),
    window.location.origin,
  );
}
configureClientUpdateCacheResetAdapter({
  prepare: () => storeManagerClient.prepareClientUpdateCacheReset(),
});
setTelemetryTransport(storeManagerClient.telemetry);
// A dirty-session beforeunload can be canceled. Dispose only after an actual
// non-BFCache leave; Cancel must retain worker ports and subsequent saving.
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) storeManagerClient.dispose();
});
window.addEventListener("focus", () => {
  storeManagerClient.resume();
});
window.addEventListener("click", () => {
  storeManagerClient.resume();
});
window.addEventListener("blur", () => {
  storeManagerClient.pause();
});

const framework = new Framework();
configureCommonShellModules(framework);
registerWorkspaceFeatureLoader(async () => {
  const { configureCommonWorkspaceFeatureModules } =
    await import("@myoxus/core/modules/workspace-features");
  configureCommonWorkspaceFeatureModules(framework);
});
configureBrowserWorkbenchModule(framework);
configureLocalStorageStateStorageImpls(framework);
configureBrowserWorkspaceFlavours(framework);
framework.impl(StoreProvider, {
  openStore(key, options) {
    return storeManagerClient.open(key, options);
  },
});
framework.impl(PopupWindowProvider, {
  /**
   * Opens a URL in a new popup window.
   *
   * Same-origin URLs are opened directly. Cross-origin URLs are routed through
   * the server-side `/redirect-proxy` endpoint to prevent leaking the referrer
   * and enforce CSP without blocking the navigation.
   */
  open: (target: string) => {
    const targetUrl = new URL(target);

    let url: string;
    // safe to open directly if in the same origin
    if (targetUrl.origin === location.origin) {
      url = target;
    } else {
      const redirectProxy = location.origin + "/redirect-proxy";
      const search = new URLSearchParams({
        redirect_uri: target,
      });

      url = `${redirectProxy}?${search.toString()}`;
    }
    window.open(url, "_blank", "popup noreferrer noopener");
  },
});
const frameworkProvider = framework.provider();

// setup application lifecycle events, and emit application start event
window.addEventListener("focus", () => {
  frameworkProvider.get(LifecycleService).applicationFocus();
});
frameworkProvider.get(LifecycleService).applicationStart();

/**
 * Root React component for the Myoxus web application.
 *
 * Renders the full provider stack in order:
 * - FrameworkRoot  — dependency-injection context
 * - I18nProvider   — internationalisation
 * - MyoxusContext  — Jotai atom store
 * - RouterProvider — client-side routing (React Router v7)
 *
 * Wrapped in <Suspense> to handle async module boundaries during lazy loading.
 */
export function App() {
  return (
    <Suspense>
      <FrameworkRoot framework={frameworkProvider}>
        <Telemetry />
        <I18nProvider>
          <MyoxusContext store={getCurrentStore()}>
            <ClientUpdateSurface>
              <RouterProvider router={router} />
            </ClientUpdateSurface>
          </MyoxusContext>
        </I18nProvider>
      </FrameworkRoot>
    </Suspense>
  );
}
