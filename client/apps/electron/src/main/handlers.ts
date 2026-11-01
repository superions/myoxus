import { I18n } from "@myoxus/i18n";
import { ipcMain } from "electron";

import { MYOXUS_API_CHANNEL_NAME } from "../shared/type";
import { clipboardHandlers } from "./clipboard";
import { findInPageHandlers } from "./find-in-page";
import { getLogFilePath, logger, revealLogFile } from "./logger";
import { recordingHandlers } from "./recording";
import { sharedStorageHandlers } from "./shared-storage";
import type { MainHandlerImplementations } from "./type";
import { uiHandlers } from "./ui/handlers";
import { updaterHandlers } from "./updater";
import { popupHandlers } from "./windows-manager/popup";
import { workerHandlers } from "./worker/handlers";

export const debugHandlers = {
  revealLogFile: async () => {
    return revealLogFile();
  },
  logFilePath: async () => {
    return getLogFilePath();
  },
};

export const i18nHandlers = {
  changeLanguage: async (_: Electron.IpcMainInvokeEvent, language: string) => {
    // i18next resolves with its translation function, which Electron cannot
    // structured-clone across IPC. Language synchronization is a command, so
    // await completion without exposing that implementation-only value.
    await I18n.changeLanguage(language);
  },
};

// Note: all of these handlers will be the single-source-of-truth for the apis exposed to the renderer process
export const allHandlers = {
  debug: debugHandlers,
  ui: uiHandlers,
  clipboard: clipboardHandlers,
  updater: updaterHandlers,
  findInPage: findInPageHandlers,
  sharedStorage: sharedStorageHandlers,
  worker: workerHandlers,
  recording: recordingHandlers,
  popup: popupHandlers,
  i18n: i18nHandlers,
} satisfies MainHandlerImplementations;

export const registerHandlers = () => {
  type RuntimeHandler = (
    event: Electron.IpcMainInvokeEvent,
    ...args: unknown[]
  ) => Promise<unknown>;
  const runtimeHandlers = allHandlers as unknown as Readonly<
    Record<string, Readonly<Record<string, RuntimeHandler>>>
  >;

  const handleIpcMessage = async (
    e: Electron.IpcMainInvokeEvent,
    ...args: unknown[]
  ) => {
    // args[0] is the `{namespace:key}`
    if (typeof args[0] !== "string") {
      throw new Error("Invalid desktop IPC message");
    }
    const channel = args[0] as string;
    const [namespace, key] = channel.split(":");

    if (!namespace || !key) {
      throw new Error("Invalid desktop IPC channel");
    }

    const handler = runtimeHandlers[namespace]?.[key];

    if (!handler) {
      throw new Error(`Desktop IPC handler not found: ${channel}`);
    }

    const start = Date.now();
    const realArgs = args.slice(1);
    const result = await handler(e, ...realArgs);

    logger.debug(
      "[ipc-api]",
      channel,
      realArgs.filter(
        (arg) => typeof arg !== "function" && typeof arg !== "object",
      ),
      "-",
      Date.now() - start,
      "ms",
    );

    return result;
  };

  ipcMain.handle(MYOXUS_API_CHANNEL_NAME, async (e, ...args: unknown[]) => {
    try {
      return await handleIpcMessage(e, ...args);
    } catch (error) {
      logger.error(`error in ipc handler when calling ${args[0]}`, error);
      throw error;
    }
  });
};
