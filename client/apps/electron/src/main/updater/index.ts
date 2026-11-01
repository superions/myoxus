import { app, type IpcMainInvokeEvent } from "electron";

import {
  checkForUpdates,
  downloadUpdate,
  getConfig,
  getUpdaterState,
  quitAndInstall,
  setConfig,
  type UpdaterConfig,
} from "./electron-updater";

export const updaterHandlers = {
  currentVersion: async () => {
    return app.getVersion();
  },
  quitAndInstall: async () => {
    return quitAndInstall();
  },
  downloadUpdate: async () => {
    return downloadUpdate();
  },
  getConfig: async (): Promise<UpdaterConfig> => {
    return getConfig();
  },
  setConfig: async (
    _e: IpcMainInvokeEvent,
    newConfig: Partial<UpdaterConfig>,
  ): Promise<void> => {
    return setConfig(newConfig);
  },
  getState: async () => getUpdaterState(),
  checkForUpdates: async () => checkForUpdates(),
} satisfies MainHandlerImplementations["updater"];

export * from "./electron-updater";
import type { MainHandlerImplementations } from "../type";
