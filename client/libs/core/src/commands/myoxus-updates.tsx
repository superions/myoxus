import { updateReadyAtom } from "@myoxus/core/components/hooks/use-app-updater";
import type { useI18n } from "@myoxus/i18n";
import { ResetIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import type { createStore } from "jotai";

import { registerMyoxusCommand } from "./registry";

export function registerMyoxusUpdatesCommands({
  t,
  store,
  quitAndInstall,
}: {
  t: ReturnType<typeof useI18n>;
  store: ReturnType<typeof createStore>;
  quitAndInstall: () => Promise<void>;
}) {
  const unsubs: Array<() => void> = [];

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:restart-to-upgrade",
      category: "myoxus:updates",
      icon: <ResetIcon />,
      label: t["com.myoxus.cmdk.restart-to-upgrade"](),
      preconditionStrategy: () => !!store.get(updateReadyAtom),
      run() {
        track.$.cmdk.updates.quitAndInstall();

        quitAndInstall().catch((err) => {
          notify.error({
            title: "Failed to restart to upgrade",
            message: "Please restart the app manually to upgrade.",
          });
          console.error(err);
        });
      },
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}
