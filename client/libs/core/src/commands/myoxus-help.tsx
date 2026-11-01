import type { useI18n } from "@myoxus/i18n";
import { ContactWithUsIcon, NewIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";

import type { WorkspaceDialogService } from "../modules/dialogs";
import type { UrlService } from "../modules/url";
import { registerMyoxusCommand } from "./registry";

export function registerMyoxusHelpCommands({
  t,
  urlService,
  workspaceDialogService,
}: {
  t: ReturnType<typeof useI18n>;
  urlService: UrlService;
  workspaceDialogService: WorkspaceDialogService;
}) {
  const unsubs: Array<() => void> = [];
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:help-whats-new",
      category: "myoxus:help",
      icon: <NewIcon />,
      label: t["com.myoxus.cmdk.whats-new"](),
      run() {
        track.$.cmdk.help.openChangelog();
        urlService.openPopupWindow(BUILD_CONFIG.changelogUrl);
      },
    }),
  );
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:help-contact-us",
      category: "myoxus:help",
      icon: <ContactWithUsIcon />,
      label: t["com.myoxus.cmdk.contact-us"](),
      run() {
        track.$.cmdk.help.contactUs();
        workspaceDialogService.open("user-settings", {
          activeTab: "about",
        });
      },
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}
