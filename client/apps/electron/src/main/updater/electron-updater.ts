import type { UpdateInfo } from "@myoxus/desktop-api-contract";
import { app } from "electron";

import { buildType, electronE2e, electronE2eUpdateFeed } from "../config";
import { logger } from "../logger";
import { quitAfterAdmission } from "../cleanup";
import { selectDesktopUpdater } from "./desktop-updater-port";
import { updaterSubjects, updateState } from "./event";
import { MyoxusUpdateProvider } from "./myoxus-update-provider";

const mode = process.env.NODE_ENV;
const isDev = mode === "development";

const updaterSelection = selectDesktopUpdater();
const disabled = isDev || updaterSelection.state === "disabled";

export const autoUpdater =
  updaterSelection.state === "enabled" ? updaterSelection.updater : null;

export const quitAndInstall = async () => {
  if (getUpdaterState().ready && autoUpdater)
    await quitAfterAdmission(() => {
      // The user already chose restart and renderer admission succeeded. NSIS
      // must activate without a second wizard, then relaunch the new version.
      if (
        updaterSelection.state === "enabled" &&
        updaterSelection.target.platform === "win32"
      )
        autoUpdater.quitAndInstall(true, true);
      else autoUpdater.quitAndInstall();
    });
};

let downloading = false;
let configured = false;
let checkingUpdate: Promise<UpdateInfo> | undefined;

updateState({
  availability: isDev
    ? { state: "disabled", reason: "development" }
    : updaterSelection.state === "disabled"
      ? { state: "disabled", reason: updaterSelection.reason }
      : { state: "enabled" },
});
export const getUpdaterState = () => updaterSubjects.state$.value;

export type UpdaterConfig = {
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;
};

const config: UpdaterConfig = {
  autoCheckUpdate: true,
  autoDownloadUpdate: true,
};

export const getConfig = (): UpdaterConfig => {
  return { ...config };
};

export const setConfig = (newConfig: Partial<UpdaterConfig> = {}): void => {
  configured = true;

  Object.assign(config, newConfig);

  logger.info("Updater configured!", config);

  // if config.autoCheckUpdate is true, trigger a check
  if (config.autoCheckUpdate && !electronE2e) {
    checkForUpdates().catch((err) => {
      logger.error("Error checking for updates", err);
    });
  }
};

export const checkForUpdates = (): Promise<UpdateInfo> => {
  const availability = getUpdaterState().availability;
  if (availability.state === "disabled" || !autoUpdater) {
    return Promise.resolve({
      state: "unavailable",
      reason:
        availability.state === "disabled"
          ? availability.reason
          : "unsupported-platform",
    });
  }
  if (checkingUpdate) return checkingUpdate;
  updateState({ phase: "checking" });
  checkingUpdate = (async (): Promise<UpdateInfo> => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) throw new Error("Update check did not complete");
      return {
        state: "checked",
        version: getUpdaterState().available?.version ?? null,
      };
    } catch (error) {
      updateState({ phase: "error", progress: null });
      throw error;
    } finally {
      checkingUpdate = undefined;
    }
  })();
  return checkingUpdate;
};

export const downloadUpdate = async () => {
  if (disabled || !autoUpdater || downloading || !getUpdaterState().available) {
    return;
  }
  downloading = true;
  updateState({ phase: "downloading", progress: 0 });
  logger.info("Update available, downloading...");
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    updateState({ phase: "error", progress: null });
    logger.error("Failed to download update", error);
    throw error;
  } finally {
    downloading = false;
  }
};

export const registerUpdater = async () => {
  if (disabled || !autoUpdater || updaterSelection.state !== "enabled") {
    if (!isDev && updaterSelection.state === "disabled") {
      logger.info("Desktop updater disabled", {
        reason: updaterSelection.reason,
      });
    }
    return;
  }

  const updater = autoUpdater;
  const allowAutoUpdate = true;

  updater.logger = logger;
  updater.autoDownload = false;
  updater.allowPrerelease = buildType !== "stable";
  updater.allowDowngrade = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;

  const feedUrl = MyoxusUpdateProvider.configFeed({
    channel: buildType,
    feedUrl: electronE2eUpdateFeed ?? undefined,
    target: updaterSelection.target,
  });

  updater.setFeedURL(feedUrl);

  // register events for checkForUpdates
  updater.on("checking-for-update", () => {
    logger.info("Checking for update");
  });
  updater.on("update-available", (info) => {
    logger.info("Update available", info);
    updateState({
      phase: "available",
      available: { version: info.version, allowAutoUpdate },
      ready: null,
      progress: null,
    });
    if (config.autoDownloadUpdate && allowAutoUpdate) {
      downloadUpdate().catch((err) =>
        logger.error("Failed to start update download", err),
      );
    }
  });
  updater.on("update-not-available", (info) => {
    updateState({
      phase: "latest",
      available: null,
      ready: null,
      progress: null,
    });
    logger.info("Update not available", info);
  });
  updater.on("download-progress", (e) => {
    logger.info(`Download progress: ${e.percent}`);
    updateState({ phase: "downloading", progress: e.percent });
  });
  updater.on("update-downloaded", (e) => {
    downloading = false;
    updateState({
      phase: "ready",
      progress: null,
      ready: { version: e.version, allowAutoUpdate },
    });
    logger.info("Update downloaded, ready to install");
  });
  updater.on("error", (e) => {
    downloading = false;
    updateState({ phase: "error", progress: null });
    logger.error("Error while updating client", e);
  });

  // check update whenever the window is activated
  let lastCheckTime = 0;
  app.on("browser-window-focus", () => {
    (async () => {
      if (
        !electronE2e &&
        configured &&
        config.autoCheckUpdate &&
        lastCheckTime + 1000 * 1800 < Date.now()
      ) {
        lastCheckTime = Date.now();
        await checkForUpdates();
      }
    })().catch((err) => {
      logger.error("Error checking for updates", err);
    });
  });
};
