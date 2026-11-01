import { useAppUpdater } from "@myoxus/core/components/hooks/use-app-updater";
import { AppUpdaterButton } from "@myoxus/core/modules/app-sidebar/views";
import { Suspense } from "react";

const UpdaterButtonInner = () => {
  const appUpdater = useAppUpdater();

  return (
    <AppUpdaterButton
      onQuitAndInstall={appUpdater.quitAndInstall}
      onDownloadUpdate={appUpdater.downloadUpdate}
      onDismissChangelog={appUpdater.dismissChangelog}
      onOpenChangelog={appUpdater.openChangelog}
      changelogUnread={appUpdater.changelogUnread}
      updateReady={!!appUpdater.updateReady}
      updateAvailable={appUpdater.updateAvailable}
      downloadProgress={appUpdater.downloadProgress}
      appQuitting={appUpdater.appQuitting}
    />
  );
};

export const UpdaterButton = () => {
  return (
    <Suspense>
      <UpdaterButtonInner />
    </Suspense>
  );
};
