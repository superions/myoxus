import type { useI18n } from "@myoxus/i18n";
import { DisclosureTriangleIcon } from "@myoxus/icons/react";
import { track } from "@myoxus/track";
import type { Workspace } from "@virgultum/editor/store";

import type { useNavigateHelper } from "../components/hooks/use-navigate-helper";
import type { WorkspaceDialogService } from "../modules/dialogs";
import type { WorkbenchService } from "../modules/workbench";
import { registerMyoxusCommand } from "./registry";

export function registerMyoxusNavigationCommands({
  t,
  docCollection,
  navigationHelper,
  workspaceDialogService,
  workbenchService,
}: {
  t: ReturnType<typeof useI18n>;
  navigationHelper: ReturnType<typeof useNavigateHelper>;
  docCollection: Workspace;
  workspaceDialogService: WorkspaceDialogService;
  workbenchService?: WorkbenchService;
}) {
  const unsubs: Array<() => void> = [];
  const navigationIcon = () => <DisclosureTriangleIcon />;
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:goto-all-content",
      category: "myoxus:navigation",
      icon: navigationIcon(),
      label: t["com.myoxus.cmdk.navigation.goto-all-content"](),
      run() {
        track.$.cmdk.navigation.navigate({
          to: "allDocs",
        });

        navigationHelper.jumpToPage(docCollection.id, "all");
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:goto-collection-list",
      category: "myoxus:navigation",
      icon: navigationIcon(),
      label: t["com.myoxus.cmdk.navigation.goto-collections"](),
      run() {
        track.$.cmdk.navigation.navigate({
          to: "collectionList",
        });

        navigationHelper.jumpToCollections(docCollection.id);
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:goto-tag-list",
      category: "myoxus:navigation",
      icon: navigationIcon(),
      label: t["com.myoxus.cmdk.navigation.goto-tags"](),
      run() {
        track.$.cmdk.navigation.navigate({
          to: "tagList",
        });

        navigationHelper.jumpToTags(docCollection.id);
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:goto-workspace",
      category: "myoxus:navigation",
      icon: navigationIcon(),
      label: t["com.myoxus.cmdk.navigation.goto-workspace"](),
      run() {
        track.$.cmdk.navigation.navigate({
          to: "workspace",
        });

        workbenchService?.workbench.openWorkspaceSelector();
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:open-settings",
      category: "myoxus:navigation",
      icon: navigationIcon(),
      label: t["com.myoxus.cmdk.navigation.open-settings"](),
      keyBinding: "$mod+,",
      run() {
        track.$.cmdk.settings.openSettings();
        workspaceDialogService.open("user-settings", {
          activeTab: "appearance",
        });
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:open-account",
      category: "myoxus:navigation",
      icon: navigationIcon(),
      label: t["com.myoxus.cmdk.navigation.open-account-settings"](),
      run() {
        track.$.cmdk.settings.openSettings({ to: "account" });
        workspaceDialogService.open("user-settings", {
          activeTab: "account",
        });
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:goto-trash",
      category: "myoxus:navigation",
      icon: navigationIcon(),
      label: t["com.myoxus.cmdk.navigation.goto-trash"](),
      run() {
        track.$.cmdk.navigation.navigate({
          to: "trash",
        });

        navigationHelper.jumpToPage(docCollection.id, "trash");
      },
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}
