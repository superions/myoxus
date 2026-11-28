// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useAppUpdater } from "@myoxus/core/components/hooks/use-app-updater";
import { useI18n } from "@myoxus/i18n";

import {
  MyoxusButton,
  MyoxusLoader,
  SettingsRow,
  SettingsStatusText,
} from "../../primitives";

export const UpdateCheckSection = () => {
  const t = useI18n();
  const {
    updaterState,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    externalMacosInstall,
    openDownloadPage,
  } = useAppUpdater();

  // Wait for the initial updater snapshot before exposing native update controls.
  if (!updaterState) {
    return null;
  }

  const disabledReason =
    updaterState.availability.state === "disabled"
      ? updaterState.availability.reason
      : null;
  const isBusy =
    updaterState.phase === "checking" || updaterState.phase === "downloading";

  const resolveActionLabel = (): string => {
    if (updaterState.ready) {
      return t["com.myoxus.aboutMyoxus.checkUpdate.button.restart"]();
    }
    if (updaterState.available && updaterState.progress === null) {
      return t["com.myoxus.aboutMyoxus.checkUpdate.button.download"]();
    }
    if (updaterState.phase === "error" || updaterState.phase === "latest") {
      return t["com.myoxus.aboutMyoxus.checkUpdate.button.retry"]();
    }
    return t["com.myoxus.aboutMyoxus.checkUpdate.button.check"]();
  };

  const resolveSubtitle = (): string => {
    if (externalMacosInstall) {
      return t[
        "com.myoxus.aboutMyoxus.checkUpdate.subtitle.external-macos-install"
      ]();
    }
    if (disabledReason === "externally-managed") {
      return t[
        "com.myoxus.aboutMyoxus.checkUpdate.subtitle.externally-managed"
      ]();
    }
    if (disabledReason === "portable") {
      return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.portable"]();
    }
    if (disabledReason) {
      return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.disabled"]();
    }
    if (updaterState.phase === "error") {
      return t["com.myoxus.common.operation-failed"]();
    }
    if (updaterState.ready) {
      return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.restart"]();
    }
    if (updaterState.phase === "checking") {
      return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.checking"]();
    }
    if (updaterState.progress !== null && updaterState.progress !== undefined) {
      return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.downloading"]();
    }
    if (updaterState.available) {
      return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.update-available"]({
        version: updaterState.available.version,
      });
    }
    if (updaterState.phase === "latest") {
      return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.latest"]();
    }
    return t["com.myoxus.aboutMyoxus.checkUpdate.subtitle.check"]();
  };

  const handleAction = () => {
    if (updaterState.ready) {
      quitAndInstall();
      return;
    }
    if (updaterState.available && updaterState.progress === null) {
      downloadUpdate();
      return;
    }
    void checkForUpdates();
  };

  return (
    <SettingsRow
      name={
        externalMacosInstall
          ? t[
              "com.myoxus.aboutMyoxus.checkUpdate.title.external-macos-install"
            ]()
          : t["com.myoxus.aboutMyoxus.checkUpdate.title"]()
      }
      desc={
        <SettingsStatusText
          tone={updaterState.phase === "error" ? "error" : "muted"}
        >
          {isBusy ? <MyoxusLoader /> : null}
          {resolveSubtitle()}
        </SettingsStatusText>
      }
    >
      {externalMacosInstall ? (
        <MyoxusButton onClick={openDownloadPage}>
          {t["com.myoxus.appUpdater.openDownloadPage"]()}
        </MyoxusButton>
      ) : (
        <MyoxusButton
          data-testid="check-update-button"
          onClick={handleAction}
          disabled={Boolean(disabledReason) || isBusy}
        >
          {resolveActionLabel()}
        </MyoxusButton>
      )}
    </SettingsRow>
  );
};
