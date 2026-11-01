// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createControllerReloadCoordinator,
  readServiceWorkerBuildId,
  updateServiceWorkerRegistration,
} from "./service-worker-update";

function createHarness({
  controlledAtStartup = true,
  initialVisibility = "visible",
}: {
  controlledAtStartup?: boolean;
  initialVisibility?: DocumentVisibilityState;
} = {}) {
  let visibility = initialVisibility;
  let reloads = 0;
  const listeners = new Set<() => void>();
  const coordinator = createControllerReloadCoordinator({
    controlledAtStartup,
    visibilityState: () => visibility,
    reload: () => {
      reloads += 1;
    },
    addVisibilityChangeListener: (listener) => {
      listeners.add(listener);
    },
    removeVisibilityChangeListener: (listener) => {
      listeners.delete(listener);
    },
  });

  return {
    coordinator,
    get listenerCount() {
      return listeners.size;
    },
    get reloads() {
      return reloads;
    },
    setVisibility(next: DocumentVisibilityState) {
      visibility = next;
      // A listener may unsubscribe itself while handling the visibility change.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const listener of [...listeners]) listener();
    },
  };
}

class SynchronousMessageChannel {
  readonly port1 = {
    close: vi.fn(),
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  };
  readonly port2 = {
    postMessage: (data: unknown) => {
      this.port1.onmessage?.({ data } as MessageEvent<unknown>);
    },
  };
}

function buildController(buildId: string): ServiceWorker {
  return {
    postMessage(_message: unknown, ports: Transferable[]) {
      (ports[0] as unknown as { postMessage(data: unknown): void }).postMessage(
        {
          type: "myoxus:build-id",
          buildId,
        },
      );
    },
  } as unknown as ServiceWorker;
}

function buildServiceWorkerContainer({
  initialBuildId,
  onListenerAdded,
}: {
  initialBuildId: string;
  onListenerAdded?: (container: ServiceWorkerContainer) => void;
}) {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const registration = { update: vi.fn(async () => undefined) };
  const container = {
    controller: buildController(initialBuildId),
    ready: Promise.resolve(registration),
    addEventListener: vi.fn(
      (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.add(listener);
        onListenerAdded?.(container as unknown as ServiceWorkerContainer);
      },
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.delete(listener);
      },
    ),
  };
  return {
    container: container as unknown as ServiceWorkerContainer,
    registration,
    listeners,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("service worker controller reload coordinator", () => {
  test("rejects a required build when service workers are unavailable", async () => {
    await expect(
      updateServiceWorkerRegistration(null, "required-build"),
    ).rejects.toThrow(
      "Required service worker build cannot activate without service worker support",
    );
  });

  test("reads the build identity projected by the active worker", async () => {
    const controller = {
      postMessage(message: unknown, ports: Transferable[]) {
        expect(message).toEqual({ type: "myoxus:get-build-id" });
        (ports[0] as MessagePort).postMessage({
          type: "myoxus:build-id",
          buildId: "0.40.2-revision",
        });
      },
    } as unknown as ServiceWorker;

    await expect(readServiceWorkerBuildId(controller)).resolves.toBe(
      "0.40.2-revision",
    );
  });

  test("closes the activation race and removes the controller listener", async () => {
    vi.stubGlobal("MessageChannel", SynchronousMessageChannel);
    const harness = buildServiceWorkerContainer({
      initialBuildId: "old-build",
      onListenerAdded: (container) => {
        Object.assign(container, {
          controller: buildController("required-build"),
        });
      },
    });

    await expect(
      updateServiceWorkerRegistration(harness.container, "required-build"),
    ).resolves.toBeUndefined();

    expect(harness.registration.update).toHaveBeenCalledOnce();
    expect(harness.container.removeEventListener).toHaveBeenCalledOnce();
    expect(harness.listeners.size).toBe(0);
  });

  test("rejects a missing required build on timeout and removes its listener", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MessageChannel", SynchronousMessageChannel);
    const harness = buildServiceWorkerContainer({
      initialBuildId: "old-build",
    });
    const update = updateServiceWorkerRegistration(
      harness.container,
      "required-build",
    );
    const rejection = expect(update).rejects.toThrow(
      "Required service worker build did not activate",
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(harness.container.removeEventListener).toHaveBeenCalledOnce();
    expect(harness.listeners.size).toBe(0);
  });

  test("reloads an already controlled visible page immediately", () => {
    const harness = createHarness();

    harness.coordinator.controllerChanged();

    expect(harness.reloads).toBe(1);
    expect(harness.listenerCount).toBe(0);
  });

  test("reloads a hidden page once when it next becomes visible", () => {
    const harness = createHarness({ initialVisibility: "hidden" });

    harness.coordinator.controllerChanged();
    harness.coordinator.controllerChanged();

    expect(harness.reloads).toBe(0);
    expect(harness.listenerCount).toBe(1);

    harness.setVisibility("visible");
    harness.setVisibility("hidden");
    harness.setVisibility("visible");

    expect(harness.reloads).toBe(1);
    expect(harness.listenerCount).toBe(0);
  });

  test("ignores first installation without an existing controller", () => {
    const harness = createHarness({ controlledAtStartup: false });

    harness.coordinator.controllerChanged();

    expect(harness.reloads).toBe(0);
    expect(harness.listenerCount).toBe(0);
  });

  test("dispose removes a pending visibility listener", () => {
    const harness = createHarness({ initialVisibility: "hidden" });

    harness.coordinator.controllerChanged();
    harness.coordinator.dispose();
    harness.setVisibility("visible");

    expect(harness.reloads).toBe(0);
    expect(harness.listenerCount).toBe(0);
  });

  test("holds a controller reload while updates are blocked", () => {
    const harness = createHarness();

    harness.coordinator.setReloadBlocked(true);
    harness.coordinator.controllerChanged();
    expect(harness.reloads).toBe(0);

    harness.coordinator.setReloadBlocked(false);
    expect(harness.reloads).toBe(1);
  });

  test("accepts a server-only reload without an existing controller", () => {
    const harness = createHarness({ controlledAtStartup: false });

    harness.coordinator.requestReload();
    harness.coordinator.requestReload();

    expect(harness.reloads).toBe(1);
  });
});
