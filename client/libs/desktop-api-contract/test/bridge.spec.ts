// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from "vitest";

import {
  DesktopBridgeInitializationError,
  getDesktopBridge,
  type SharedStorage,
} from "../src/bridge";
import * as rootContract from "../src/index";
import {
  clientEventChannelManifest,
  clientHandlerChannelManifest,
  type SharedStorageValue,
} from "../src/index";

const globalNames = [
  "__appInfo",
  "__apis",
  "__events",
  "__sharedStorage",
] as const;

function createChannelSurface(manifest: object) {
  return Object.fromEntries(
    Object.entries(manifest).map(([namespace, channels]) => [
      namespace,
      Object.fromEntries(
        Object.keys(channels).map((channel) => [
          channel,
          async () => undefined,
        ]),
      ),
    ]),
  );
}

function createStorageArea() {
  return {
    ready: Promise.resolve(),
    keys: () => [],
    get: <Value extends SharedStorageValue>() => undefined as Value | undefined,
    watch:
      <Value extends SharedStorageValue>(
        _key: string,
        _callback: (value: Value | undefined) => void,
      ) =>
      () =>
        undefined,
    set: <Value extends SharedStorageValue>(_key: string, _value: Value) =>
      undefined,
    del: () => undefined,
    clear: () => undefined,
  };
}

function installValidBridge() {
  Reflect.set(globalThis, "__appInfo", {
    electron: true,
    windowName: "main",
    viewId: "view-1",
    scheme: "myoxus",
  });
  Reflect.set(
    globalThis,
    "__apis",
    createChannelSurface(clientHandlerChannelManifest),
  );
  Reflect.set(
    globalThis,
    "__events",
    createChannelSurface(clientEventChannelManifest),
  );
  Reflect.set(globalThis, "__sharedStorage", {
    globalState: createStorageArea(),
    globalCache: createStorageArea(),
  } satisfies SharedStorage);
}

function expectInitializationError(
  callback: () => void,
  code: DesktopBridgeInitializationError["code"],
) {
  try {
    callback();
    throw new Error("Expected desktop bridge initialization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopBridgeInitializationError);
    expect((error as DesktopBridgeInitializationError).code).toBe(code);
  }
}

afterEach(() => {
  for (const name of globalNames) {
    Reflect.deleteProperty(globalThis, name);
  }
});

describe("getDesktopBridge", () => {
  test("keeps runtime global access out of the root contract surface", () => {
    expect("getDesktopBridge" in rootContract).toBe(false);
    expect("DesktopBridgeInitializationError" in rootContract).toBe(false);
  });

  test("returns null only when all four preload globals are absent", () => {
    expect(getDesktopBridge()).toBeNull();

    Reflect.set(globalThis, "__appInfo", {
      electron: true,
      windowName: "main",
      viewId: "view-1",
      scheme: "myoxus",
    });
    expectInitializationError(() => getDesktopBridge(), "PARTIAL_GLOBALS");
  });

  test("returns the complete bridge when every exact manifest channel exists", () => {
    installValidBridge();

    const bridge = getDesktopBridge();

    expect(bridge?.appInfo.viewId).toBe("view-1");
    expect(typeof bridge?.apis.ui.moveTab).toBe("function");
    expect(typeof bridge?.events.power["power-source"]).toBe("function");
    expect(bridge?.sharedStorage.globalState.ready).toBeInstanceOf(Promise);
    const apis = createChannelSurface(clientHandlerChannelManifest);
    Reflect.deleteProperty(Reflect.get(apis, "ui"), "saveExportFile");
    Reflect.set(globalThis, "__apis", apis);
    const publishedClient = getDesktopBridge();
    expect(publishedClient?.apis.ui.saveExportFile).toBeUndefined();
    expect(typeof publishedClient?.apis.ui.savePdf).toBe("function");
  });

  test("rejects malformed app metadata instead of treating it as browser mode", () => {
    installValidBridge();
    Reflect.set(globalThis, "__appInfo", {
      electron: false,
      windowName: "main",
      viewId: "view-1",
      scheme: "myoxus",
    });

    expectInitializationError(() => getDesktopBridge(), "INVALID_APP_INFO");

    installValidBridge();
    Reflect.set(globalThis, "__appInfo", {
      electron: true,
      windowName: "main",
      viewId: "view-1",
      scheme: "invented-scheme",
    });

    expectInitializationError(() => getDesktopBridge(), "INVALID_APP_INFO");
  });

  test("rejects missing and additional API channels in both directions", () => {
    installValidBridge();
    const apis = createChannelSurface(clientHandlerChannelManifest);
    const ui = Reflect.get(apis, "ui");
    Reflect.deleteProperty(ui, "moveTab");
    Reflect.set(globalThis, "__apis", apis);
    expectInitializationError(() => getDesktopBridge(), "INVALID_APIS");

    installValidBridge();
    const events = createChannelSurface(clientEventChannelManifest);
    Reflect.set(events, "inventedNamespace", {});
    Reflect.set(globalThis, "__events", events);
    expectInitializationError(() => getDesktopBridge(), "INVALID_EVENTS");
  });

  test("rejects a shared-storage area with an incomplete runtime shape", () => {
    installValidBridge();
    const malformedArea = createStorageArea();
    Reflect.deleteProperty(malformedArea, "watch");
    Reflect.set(globalThis, "__sharedStorage", {
      globalState: malformedArea,
      globalCache: createStorageArea(),
    });

    expectInitializationError(
      () => getDesktopBridge(),
      "INVALID_SHARED_STORAGE",
    );
  });
});
