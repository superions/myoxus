/**
 * @file settings.ts — @myoxus/infra (atom)
 *
 * Jotai atoms for persisted device settings.
 *
 * The settings are stored under the `myoxus-device-settings` key in `localStorage`
 * via `atomWithStorage`.  On Electron, changes to auto-update settings are
 * automatically synced to the native updater API via a `jotai-effect`.
 *
 * Account preferences deliberately do not belong here. They are persisted by
 * the server and cached by `UserPreferencesService`.
 *
 * Consumers: settings panels in `client/web` and `client/admin`;
 * `client/apps/electron-renderer` for Electron-specific sync.
 */

import { DebugLogger } from "@myoxus/debug";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { setupGlobal } from "@myoxus/env/global";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomEffect } from "jotai-effect";

setupGlobal();

const logger = new DebugLogger("myoxus:settings");

/**
 * The shape of all persisted application settings.
 *
 * Defaults are applied at initialisation time and may vary by platform
 * (e.g. `clientBorder` defaults to `true` on Electron/macOS).
 */
export type DeviceSetting = {
  /**
   * Whether to render a custom client-side window border.
   * Defaults to `true` on Electron (non-Windows) where the native title bar
   * is hidden.
   */
  clientBorder: boolean;
  /**
   * The style of the window frame.
   * `'frameless'` hides the native title bar; `'NativeTitleBar'` shows it.
   */
  windowFrameStyle: "frameless" | "NativeTitleBar";
  /** Whether to enable a blurred background effect (macOS Electron only). */
  enableBlurBackground: boolean;
  /** Whether the Electron app checks for updates automatically on launch. */
  autoCheckUpdate: boolean;
  /** Whether the Electron app downloads updates automatically after checking. */
  autoDownloadUpdate: boolean;
};

/** All valid values for the `windowFrameStyle` setting. */
export const windowFrameStyleOptions: DeviceSetting["windowFrameStyle"][] = [
  "frameless",
  "NativeTitleBar",
];

export const DEVICE_SETTINGS_STORAGE_KEY = "myoxus-device-settings";

/**
 * Base Jotai atom backed by `localStorage`.  Do not use directly; prefer
 * the public {@link deviceSettingAtom} which exposes merge-update semantics.
 */
const deviceSettingBaseAtom = atomWithStorage<DeviceSetting>(
  DEVICE_SETTINGS_STORAGE_KEY,
  {
    clientBorder: BUILD_CONFIG.isElectron && !environment.isWindows,
    windowFrameStyle: "frameless",
    enableBlurBackground: BUILD_CONFIG.isElectron && environment.isMacOs,
    autoCheckUpdate: true,
    autoDownloadUpdate: true,
  },
  undefined,
  {
    getOnInit: true,
  },
);

type SetStateAction<Value> = Value | ((prev: Value) => Value);

// todo(@pengx17): use global state instead
/**
 * Side-effect atom that syncs update-related settings to the Electron updater
 * API whenever they change.  Only active in the Electron build.
 *
 * @internal Consumed by {@link deviceSettingAtom}.
 */
const deviceSettingEffect = atomEffect((get) => {
  const settings = get(deviceSettingBaseAtom);
  // some values in settings should be synced into electron side
  if (BUILD_CONFIG.isElectron) {
    logger.debug("sync settings to electron", settings);
    // `getDesktopBridge()` throws on partial globals (test harnesses, partial
    // preload scripts). Tolerate that here so a stale or dev-only bridge
    // surface does not crash the atom-effect when settings are read in
    // environments that are not the Electron renderer.
    let bridge: ReturnType<typeof getDesktopBridge> = null;
    try {
      bridge = getDesktopBridge();
    } catch (error) {
      logger.warn("desktop bridge unavailable, skipping updater sync", error);
    }
    bridge?.apis.updater
      .setConfig({
        autoCheckUpdate: settings.autoCheckUpdate,
        autoDownloadUpdate: settings.autoDownloadUpdate,
      })
      .catch((err: Error) => {
        console.error(err);
      });
  }
});

/**
 * Public Jotai atom for reading and updating application settings.
 *
 * **Read**: returns the current {@link DeviceSetting} (and activates the
 * Electron sync side-effect).
 *
 * **Write**: accepts a partial update object or an updater function that
 * receives the previous settings and returns a partial update.  Changes are
 * merged (not replaced) into the stored settings.
 *
 * @example
 * ```ts
 * // Read
 * const settings = useAtomValue(deviceSettingAtom);
 *
 * // Write (partial update)
 * const setSettings = useSetAtom(deviceSettingAtom);
 * setSettings({ autoCheckUpdate: false });
 *
 * // Write (updater function)
 * setSettings(prev => ({ ...prev, clientBorder: !prev.clientBorder }));
 * ```
 */
export const deviceSettingAtom = atom<
  DeviceSetting,
  [SetStateAction<Partial<DeviceSetting>>],
  void
>(
  (get) => {
    get(deviceSettingEffect);
    return get(deviceSettingBaseAtom);
  },
  (_get, set, apply) => {
    set(deviceSettingBaseAtom, (prev) => {
      const next = typeof apply === "function" ? apply(prev) : apply;
      return { ...prev, ...next };
    });
  },
);
