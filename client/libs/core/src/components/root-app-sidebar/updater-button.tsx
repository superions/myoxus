import { useAppUpdater } from "@myoxus/core/components/hooks/use-app-updater";
import { AppUpdaterButton } from "@myoxus/core/modules/app-sidebar/views";
import { useI18n } from "@myoxus/i18n";
import { DownloadIcon } from "@myoxus/icons/react";
import { SidebarNavItem, Tooltip } from "@myoxus/ui-facade";
import { Suspense } from "react";

const UpdaterButtonInner = () => {
  const appUpdater = useAppUpdater();
  const t = useI18n();

  return (
    <>
      {appUpdater.externalMacosInstall ? (
        <Tooltip
          content={t[
            "com.myoxus.aboutMyoxus.checkUpdate.subtitle.external-macos-install"
          ]()}
          side="top"
        >
          <SidebarNavItem
            icon={<DownloadIcon aria-hidden />}
            label={t["com.myoxus.appUpdater.openDownloadPage"]()}
            onClick={appUpdater.openDownloadPage}
          />
        </Tooltip>
      ) : null}
      <AppUpdaterButton
        onQuitAndInstall={appUpdater.quitAndInstall}
        onDownloadUpdate={appUpdater.downloadUpdate}
        onDismissChangelog={appUpdater.dismissChangelog}
        onOpenChangelog={appUpdater.openChangelog}
        changelogUnread={appUpdater.changelogUnread}
        updateReady={
          appUpdater.nativeUpdatesEnabled && !!appUpdater.updateReady
        }
        updateAvailable={
          appUpdater.nativeUpdatesEnabled ? appUpdater.updateAvailable : null
        }
        downloadProgress={
          appUpdater.nativeUpdatesEnabled ? appUpdater.downloadProgress : null
        }
        appQuitting={appUpdater.appQuitting}
      />
    </>
  );
};

export const UpdaterButton = () => {
  return (
    <Suspense>
      <UpdaterButtonInner />
    </Suspense>
  );
};
