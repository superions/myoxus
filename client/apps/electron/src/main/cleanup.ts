import type { MediaStats } from "@myoxus/infra";
import { app } from "electron";

import { logger } from "./logger";
import { rendererCloseAdmission } from "./close-admission";
import {
  globalCacheStorage,
  globalStateStorage,
} from "./shared-storage/storage";

const beforeAppQuitRegistry: (() => void | Promise<void>)[] = [];
const beforeTabCloseRegistry: ((tabId: string) => void)[] = [];
let cleanupComplete = false;
let cleanupPromise: Promise<boolean> | undefined;
let appQuitInProgress = false;
let stateLoaded = false;

export function beforeAppQuit(fn: () => void | Promise<void>) {
  beforeAppQuitRegistry.push(fn);
}

export function beforeTabClose(fn: (tabId: string) => void) {
  beforeTabCloseRegistry.push(fn);
}

export function isAppQuitInProgress() {
  return appQuitInProgress;
}

app.on("before-quit", (event) => {
  if (cleanupComplete) return;
  event.preventDefault();
  void quitAfterAdmission();
});

/** No cleanup or relaunch/install side effect occurs before renderer admission.
 * Concurrent intents share the first captured action; canceled later actions
 * are not queued for an unrelated future quit. */
export function quitAfterAdmission(
  action: () => void = () => app.quit(),
): Promise<boolean> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!(await rendererCloseAdmission.request())) return false;
    appQuitInProgress = true;
    try {
      for (const cleanup of beforeAppQuitRegistry) {
        try {
          await cleanup();
        } catch (error) {
          logger.warn("cleanup error on quit", error);
        }
      }
      if (stateLoaded) {
        await Promise.all([
          globalStateStorage.flush(),
          globalCacheStorage.flush(),
        ]);
      }
    } catch (error) {
      logger.error("failed to flush desktop state on quit", error);
    }
    cleanupComplete = true;
    action();
    return true;
  })().finally(() => {
    cleanupPromise = undefined;
  });
  return cleanupPromise;
}

export function onTabClose(tabId: string) {
  beforeTabCloseRegistry.forEach((fn) => {
    try {
      fn(tabId);
    } catch (err) {
      logger.warn("cleanup error on tab close", err);
    }
  });
}

export function initializeDesktopState() {
  // Load both files before any startup reset can schedule a write.
  globalStateStorage.all();
  globalCacheStorage.all();
  stateLoaded = true;
  globalStateStorage.set("media:playback-state", null);
  globalStateStorage.set("media:stats", null);
}

beforeAppQuit(() => {
  if (!stateLoaded) return;
  globalStateStorage.set("media:playback-state", null);
  globalStateStorage.set("media:stats", null);
});

// set audio play state
beforeTabClose((tabId) => {
  const stats = globalStateStorage.get<MediaStats | null>("media:stats");
  if (stats && stats.tabId === tabId) {
    globalStateStorage.set("media:playback-state", null);
    globalStateStorage.set("media:stats", null);
  }
});
