import type { useI18n } from "@myoxus/i18n";
import { SidebarIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";

import type { AppSidebarService } from "../modules/app-sidebar";
import { registerMyoxusCommand } from "./registry";

export function registerMyoxusLayoutCommands({
  t,
  appSidebarService,
}: {
  t: ReturnType<typeof useI18n>;
  appSidebarService: AppSidebarService;
}) {
  const unsubs: Array<() => void> = [];
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:toggle-left-sidebar",
      category: "myoxus:layout",
      icon: <SidebarIcon />,
      label: () =>
        appSidebarService.sidebar.open$.value
          ? t["com.myoxus.cmdk.left-sidebar.collapse"]()
          : t["com.myoxus.cmdk.left-sidebar.expand"](),

      keyBinding: {
        binding: "$mod+/",
      },
      run() {
        track.$.navigationPanel.$.toggle({
          type: appSidebarService.sidebar.open$.value ? "collapse" : "expand",
        });
        appSidebarService.sidebar.toggleSidebar();
      },
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}
