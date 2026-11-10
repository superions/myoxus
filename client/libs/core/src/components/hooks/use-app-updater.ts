// todo(@pengx17): remove jotai
import { UrlService } from "@myoxus/core/modules/url";
import type { UpdaterState } from "@myoxus/desktop-api-contract";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { useI18n } from "@myoxus/i18n";
import { deviceSettingAtom, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
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
  const t = useI18n();
  const updaterState = useAtomValue(updaterStateAtom);
  const nativeUpdatesEnabled = updaterState?.availability.state === "enabled";
  const externalMacosInstall =
    updaterState?.availability.state === "disabled" &&
    updaterState.availability.reason === "external-macos-install";
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
    if (nativeUpdatesEnabled && updateReady && !appQuitting && apis) {
      setAppQuitting(true);
      void apis.updater
        .quitAndInstall()
        .catch((err) => {
          console.error(err);
          notify.error({ title: t["com.myoxus.common.operation-failed"]() });
        })
        .finally(() => {
          // Admission can be canceled and installers can fail without an exit.
          // Keep restart/retry usable when Main returns control to this window.
          setAppQuitting(false);
        });
    }
  }, [appQuitting, nativeUpdatesEnabled, t, updateReady]);

  const checkForUpdates = useCallback(async () => {
    track.$.settingsPanel.about.checkUpdates();
    if (!nativeUpdatesEnabled || checkingForUpdates) {
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
  }, [nativeUpdatesEnabled, checkingForUpdates, setCheckingForUpdates]);

  const downloadUpdate = useCallback(() => {
    if (!nativeUpdatesEnabled) return;
    track.$.settingsPanel.about.downloadUpdate();
    apis?.updater.downloadUpdate().catch((err) => {
      console.error("Error downloading update:", err);
    });
  }, [nativeUpdatesEnabled]);

  const openDownloadPage = useCallback(() => {
    urlService.openExternal(BUILD_CONFIG.downloadUrl);
  }, [urlService]);

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
    nativeUpdatesEnabled,
    externalMacosInstall,
    openDownloadPage,
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
