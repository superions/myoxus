// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppInfo, DesktopScheme, SharedStorageValue } from "./dto";
import {
  clientEventChannelManifest,
  type ClientEvents,
  type DesktopUnsubscribe,
} from "./events";
import { type ClientHandler, clientHandlerChannelManifest } from "./handlers";

export type DesktopBridge = {
  appInfo: AppInfo;
  apis: DesktopBridgeApis;
  events: ClientEvents;
  sharedStorage: SharedStorage;
};

type DesktopBridgeApis = Omit<ClientHandler, "ui"> & {
  ui: Omit<ClientHandler["ui"], "saveExportFile"> &
    Partial<Pick<ClientHandler["ui"], "saveExportFile">>;
};

export type SharedStorageArea = {
  ready: Promise<void>;
  keys(): string[];
  get<Value extends SharedStorageValue = SharedStorageValue>(
    key: string,
  ): Value | undefined;
  watch<Value extends SharedStorageValue = SharedStorageValue>(
    key: string,
    callback: (value: Value | undefined) => void,
  ): DesktopUnsubscribe;
  set<Value extends SharedStorageValue>(key: string, value: Value): void;
  del(key: string): void;
  clear(): void;
};

export type SharedStorage = {
  globalState: SharedStorageArea;
  globalCache: SharedStorageArea;
};

export type DesktopBridgeInitializationErrorCode =
  | "PARTIAL_GLOBALS"
  | "INVALID_APP_INFO"
  | "INVALID_APIS"
  | "INVALID_EVENTS"
  | "INVALID_SHARED_STORAGE";

export class DesktopBridgeInitializationError extends Error {
  override readonly name = "DesktopBridgeInitializationError";

  constructor(
    readonly code: DesktopBridgeInitializationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type DesktopGlobalScope = typeof globalThis & {
  __appInfo?: AppInfo;
  __apis?: DesktopBridgeApis;
  __events?: ClientEvents;
  __sharedStorage?: SharedStorage;
};

function isObject(value: object | null | undefined): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(
  value: object | null | undefined,
  code: DesktopBridgeInitializationErrorCode,
  label: string,
): asserts value is object {
  if (!isObject(value)) {
    throw new DesktopBridgeInitializationError(
      code,
      `${label} must be an object`,
    );
  }
}

function assertExactKeys(
  value: object,
  expectedKeys: readonly string[],
  code: DesktopBridgeInitializationErrorCode,
  label: string,
) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new DesktopBridgeInitializationError(
      code,
      `${label} has an invalid shape`,
    );
  }
}

function assertAppInfo(value: AppInfo | undefined): asserts value is AppInfo {
  assertObject(value, "INVALID_APP_INFO", "__appInfo");
  assertExactKeys(
    value,
    ["electron", "windowName", "viewId", "scheme"],
    "INVALID_APP_INFO",
    "__appInfo",
  );
  const windowName = Reflect.get(value, "windowName");
  const viewId = Reflect.get(value, "viewId");
  const scheme = Reflect.get(value, "scheme");
  const allowedSchemes = new Set<DesktopScheme>([
    "myoxus",
    "myoxus-beta",
    "myoxus-internal",
    "myoxus-dev",
  ]);
  if (
    Reflect.get(value, "electron") !== true ||
    typeof windowName !== "string" ||
    windowName.length === 0 ||
    typeof viewId !== "string" ||
    viewId.length === 0 ||
    typeof scheme !== "string" ||
    !allowedSchemes.has(scheme as DesktopScheme)
  ) {
    throw new DesktopBridgeInitializationError(
      "INVALID_APP_INFO",
      "__appInfo contains invalid metadata",
    );
  }
}

function assertChannelSurface(
  value: object | undefined,
  manifest: object,
  code: "INVALID_APIS" | "INVALID_EVENTS",
  label: string,
): asserts value is object {
  assertObject(value, code, label);
  assertExactKeys(value, Object.keys(manifest), code, label);

  for (const namespace of Object.keys(manifest)) {
    const namespaceValue = Reflect.get(value, namespace);
    const namespaceManifest = Reflect.get(manifest, namespace);
    if (!isObject(namespaceValue) || !isObject(namespaceManifest)) {
      throw new DesktopBridgeInitializationError(
        code,
        `${label}.${namespace} must be an object`,
      );
    }
    // Published native clients predate Word saving. Only this additive
    // capability may be absent; existing channels and unknown keys stay strict.
    const channels = Object.keys(namespaceManifest).filter(
      (channel) =>
        !(
          code === "INVALID_APIS" &&
          namespace === "ui" &&
          channel === "saveExportFile" &&
          !Object.hasOwn(namespaceValue, channel)
        ),
    );
    assertExactKeys(namespaceValue, channels, code, `${label}.${namespace}`);
    for (const channel of channels) {
      if (typeof Reflect.get(namespaceValue, channel) !== "function") {
        throw new DesktopBridgeInitializationError(
          code,
          `${label}.${namespace}.${channel} must be a function`,
        );
      }
    }
  }
}

const storageAreaKeys = [
  "ready",
  "keys",
  "get",
  "watch",
  "set",
  "del",
  "clear",
] as const;

function assertSharedStorageArea(value: object, label: string) {
  assertExactKeys(value, storageAreaKeys, "INVALID_SHARED_STORAGE", label);
  const ready = Reflect.get(value, "ready");
  if (!isObject(ready) || typeof Reflect.get(ready, "then") !== "function") {
    throw new DesktopBridgeInitializationError(
      "INVALID_SHARED_STORAGE",
      `${label}.ready must be a Promise`,
    );
  }
  for (const method of storageAreaKeys.slice(1)) {
    if (typeof Reflect.get(value, method) !== "function") {
      throw new DesktopBridgeInitializationError(
        "INVALID_SHARED_STORAGE",
        `${label}.${method} must be a function`,
      );
    }
  }
}

function assertSharedStorage(
  value: SharedStorage | undefined,
): asserts value is SharedStorage {
  assertObject(value, "INVALID_SHARED_STORAGE", "__sharedStorage");
  assertExactKeys(
    value,
    ["globalState", "globalCache"],
    "INVALID_SHARED_STORAGE",
    "__sharedStorage",
  );
  const globalState = Reflect.get(value, "globalState");
  const globalCache = Reflect.get(value, "globalCache");
  if (!isObject(globalState) || !isObject(globalCache)) {
    throw new DesktopBridgeInitializationError(
      "INVALID_SHARED_STORAGE",
      "__sharedStorage areas must be objects",
    );
  }
  assertSharedStorageArea(globalState, "__sharedStorage.globalState");
  assertSharedStorageArea(globalCache, "__sharedStorage.globalCache");
}

export function getDesktopBridge(): DesktopBridge | null {
  const desktopGlobals = globalThis as DesktopGlobalScope;
  const appInfo = desktopGlobals.__appInfo;
  const apis = desktopGlobals.__apis;
  const events = desktopGlobals.__events;
  const sharedStorage = desktopGlobals.__sharedStorage;
  const presentCount = [appInfo, apis, events, sharedStorage].filter(
    (value) => value !== undefined,
  ).length;

  if (presentCount === 0) {
    return null;
  }
  if (presentCount !== 4) {
    throw new DesktopBridgeInitializationError(
      "PARTIAL_GLOBALS",
      "Desktop preload exposed only a subset of the four required globals",
    );
  }

  assertAppInfo(appInfo);
  assertChannelSurface(
    apis,
    clientHandlerChannelManifest,
    "INVALID_APIS",
    "__apis",
  );
  assertChannelSurface(
    events,
    clientEventChannelManifest,
    "INVALID_EVENTS",
    "__events",
  );
  assertSharedStorage(sharedStorage);

  return { appInfo, apis, events, sharedStorage };
}
