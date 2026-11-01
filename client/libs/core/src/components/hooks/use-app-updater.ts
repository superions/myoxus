// todo(@pengx17): remove jotai
import { UrlService } from "@myoxus/core/modules/url";
import type { UpdaterState } from "@myoxus/desktop-api-contract";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { deviceSettingAtom, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { atom, useAtom, useAtomValue } from "jotai";
import { atomWithObservable, atomWithStorage } from "jotai/utils";
import { useCallback, useState } from "react";
import { Observable } from "rxjs";

import { useAsyncCallback } from "./myoxus-async-hooks";

const desktopBridge = getDesktopBridge();
const apis = desktopBridge?.apis;
const events = desktopBridge?.events;

const updaterStateAtom = atomWithObservable(
  () =>
    new Observable<UpdaterState | null>((subscriber) => {
      subscriber.next(null);
      if (!BUILD_CONFIG.isElectron || !events || !apis) {
        subscriber.complete();
        return;
      }
      let observed = false;
      let disposed = false;
      const unsubscribe = events.updater.onStateChange((state) => {
        observed = true;
        subscriber.next(state);
      });
      // Subscribe before the snapshot; an older reply must not overwrite an event.
      void apis.updater
        .getState()
        .then((state) => {
          if (!disposed && !observed) subscriber.next(state);
        })
        .catch((error) => {
          if (!disposed) subscriber.error(error);
        });
      return () => {
        disposed = true;
        unsubscribe();
      };
    }),
  { initialValue: null },
);
export const updateReadyAtom = atom(
  (get) => get(updaterStateAtom)?.ready ?? null,
);
export const updateAvailableAtom = atom(
  (get) => get(updaterStateAtom)?.available ?? null,
);
export const downloadProgressAtom = atom(
  (get) => get(updaterStateAtom)?.progress ?? null,
);

export const changelogCheckedAtom = atomWithStorage<Record<string, boolean>>(
  "myoxus:client-changelog-checked",
  {},
);

export const checkingForUpdatesAtom = atom(false);

export const currentVersionAtom = atom(async () => {
  const currentVersion = await apis?.updater.currentVersion();
  return currentVersion;
});

const currentChangelogUnreadAtom = atom(
  async (get) => {
    const mapping = get(changelogCheckedAtom);
    const currentVersion = await get(currentVersionAtom);
    if (currentVersion) {
      return !mapping[currentVersion];
    }
    return false;
  },
  async (get, set, v: boolean) => {
    const currentVersion = await get(currentVersionAtom);
    if (currentVersion) {
      set(changelogCheckedAtom, (mapping) => {
        return {
          ...mapping,
          [currentVersion]: v,
        };
      });
    }
  },
);

export const useAppUpdater = () => {
  const updaterState = useAtomValue(updaterStateAtom);
  const [appQuitting, setAppQuitting] = useState(false);
  const updateReady = useAtomValue(updateReadyAtom);
  const urlService = useService(UrlService);
  const [setting, setSetting] = useAtom(deviceSettingAtom);
  const downloadProgress = useAtomValue(downloadProgressAtom);
  const [changelogUnread, setChangelogUnread] = useAtom(
    currentChangelogUnreadAtom,
  );

  const [checkingForUpdates, setCheckingForUpdates] = useAtom(
    checkingForUpdatesAtom,
  );

  const quitAndInstall = useCallback(() => {
    track.$.navigationPanel.bottomButtons.quitAndInstall();
    if (updateReady) {
      setAppQuitting(true);
      apis?.updater.quitAndInstall().catch((err) => {
        // TODO(@Peng): add error toast here
        console.error(err);
      });
    }
  }, [updateReady]);

  const checkForUpdates = useCallback(async () => {
    track.$.settingsPanel.about.checkUpdates();
    if (checkingForUpdates) {
      return;
    }
    setCheckingForUpdates(true);
    try {
      const updateInfo = await apis?.updater.checkForUpdates();
      if (!updateInfo || updateInfo.state === "unavailable") return null;
      return updateInfo.version ?? false;
    } catch (err) {
      console.error("Error checking for updates:", err);
      return null;
    } finally {
      setCheckingForUpdates(false);
    }
  }, [checkingForUpdates, setCheckingForUpdates]);

  const downloadUpdate = useCallback(() => {
    track.$.settingsPanel.about.downloadUpdate();
    apis?.updater.downloadUpdate().catch((err) => {
      console.error("Error downloading update:", err);
    });
  }, []);

  const toggleAutoDownload = useCallback(
    (enable: boolean) => {
      track.$.settingsPanel.about.changeAppSetting({
        key: "autoDownload",
        value: enable,
      });
      setSetting({
        autoDownloadUpdate: enable,
      });
    },
    [setSetting],
  );

  const toggleAutoCheck = useCallback(
    (enable: boolean) => {
      track.$.settingsPanel.about.changeAppSetting({
        key: "autoCheckUpdates",
        value: enable,
      });
      setSetting({
        autoCheckUpdate: enable,
      });
    },
    [setSetting],
  );

  const openChangelog = useAsyncCallback(async () => {
    track.$.navigationPanel.bottomButtons.openChangelog();
    urlService.openPopupWindow(BUILD_CONFIG.changelogUrl);
    await setChangelogUnread(true);
  }, [setChangelogUnread, urlService]);

  const dismissChangelog = useAsyncCallback(async () => {
    track.$.navigationPanel.bottomButtons.dismissChangelog();
    await setChangelogUnread(true);
  }, [setChangelogUnread]);

  return {
    updaterState,
    quitAndInstall,
    checkForUpdates,
    downloadUpdate,
    toggleAutoDownload,
    toggleAutoCheck,
    appQuitting,
    checkingForUpdates,
    autoCheck: setting.autoCheckUpdate,
    autoDownload: setting.autoDownloadUpdate,
    changelogUnread,
    openChangelog,
    dismissChangelog,
    updateReady,
    updateAvailable: useAtomValue(updateAvailableAtom),
    downloadProgress,
    currentVersion: useAtomValue(currentVersionAtom),
  };
};
