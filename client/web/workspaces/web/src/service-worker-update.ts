// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ControllerReloadEnvironment {
  controlledAtStartup: boolean;
  visibilityState(): DocumentVisibilityState;
  reload(): void;
  addVisibilityChangeListener(listener: () => void): void;
  removeVisibilityChangeListener(listener: () => void): void;
}

export interface ControllerReloadCoordinator {
  controllerChanged(): void;
  requestReload(): void;
  setReloadBlocked(blocked: boolean): void;
  dispose(): void;
}

const BUILD_ID_REQUEST = "myoxus:get-build-id";
const BUILD_ID_RESPONSE = "myoxus:build-id";

/** Reads the build identity already injected into the active service worker. */
export function readServiceWorkerBuildId(
  controller: ServiceWorker | null,
): Promise<string | null> {
  if (!controller) return Promise.resolve(null);

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = globalThis.setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, 2_000);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        data.type !== BUILD_ID_RESPONSE ||
        !("buildId" in data) ||
        typeof data.buildId !== "string"
      ) {
        return;
      }
      globalThis.clearTimeout(timeout);
      channel.port1.close();
      resolve(data.buildId);
    };
    controller.postMessage({ type: BUILD_ID_REQUEST }, [channel.port2]);
  });
}

/**
 * Requests the existing worker update path and, when an operator supplied a
 * required build, waits until that injected build identity owns the page.
 */
export async function updateServiceWorkerRegistration(
  serviceWorkers: ServiceWorkerContainer | null,
  requiredBuildId: string | null,
): Promise<void> {
  if (!serviceWorkers) {
    if (requiredBuildId) {
      throw new Error(
        "Required service worker build cannot activate without service worker support",
      );
    }
    return;
  }

  const registration = await serviceWorkers.ready;
  await registration.update();
  if (
    !requiredBuildId ||
    (await readServiceWorkerBuildId(serviceWorkers.controller)) ===
      requiredBuildId
  ) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let check = () => {};
    const cleanup = () => {
      if (timeout !== undefined) {
        globalThis.clearTimeout(timeout);
      }
      serviceWorkers.removeEventListener("controllerchange", check);
    };
    check = () => {
      if (settled) return;
      void readServiceWorkerBuildId(serviceWorkers.controller).then(
        (buildId) => {
          if (settled || buildId !== requiredBuildId) return;
          settled = true;
          cleanup();
          resolve();
        },
        (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    };
    timeout = globalThis.setTimeout(() => {
      settled = true;
      cleanup();
      reject(new Error("Required service worker build did not activate"));
    }, 15_000);

    serviceWorkers.addEventListener("controllerchange", check);
    // Close the activation race between the post-update read and listener.
    check();
  });
}

/**
 * Coordinates the one permitted page reload after an existing service worker
 * controller is replaced.
 */
export function createControllerReloadCoordinator(
  environment: ControllerReloadEnvironment,
): ControllerReloadCoordinator {
  let controllerChangeHandled = false;
  let reloadPending = false;
  let reloadPerformed = false;
  let visibilityListenerAttached = false;
  let reloadBlocked = false;
  let disposed = false;

  const reloadWhenVisible = () => {
    if (
      disposed ||
      reloadPerformed ||
      !reloadPending ||
      reloadBlocked ||
      environment.visibilityState() !== "visible"
    ) {
      return;
    }
    reloadPerformed = true;
    reloadPending = false;
    if (visibilityListenerAttached) {
      environment.removeVisibilityChangeListener(reloadWhenVisible);
      visibilityListenerAttached = false;
    }
    environment.reload();
  };

  const requestReload = () => {
    if (disposed || reloadPerformed) return;
    reloadPending = true;
    reloadWhenVisible();
    if (
      reloadPerformed ||
      disposed ||
      reloadBlocked ||
      visibilityListenerAttached
    ) {
      return;
    }

    visibilityListenerAttached = true;
    environment.addVisibilityChangeListener(reloadWhenVisible);
    reloadWhenVisible();
  };

  const controllerChanged = () => {
    if (
      disposed ||
      !environment.controlledAtStartup ||
      controllerChangeHandled
    ) {
      return;
    }
    controllerChangeHandled = true;
    requestReload();
  };

  return {
    controllerChanged,
    requestReload,
    setReloadBlocked(blocked) {
      reloadBlocked = blocked;
      if (!blocked && reloadPending) requestReload();
    },
    dispose() {
      disposed = true;
      if (visibilityListenerAttached) {
        environment.removeVisibilityChangeListener(reloadWhenVisible);
        visibilityListenerAttached = false;
      }
    },
  };
}
