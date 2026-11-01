import type { useI18n } from "@myoxus/i18n";
import {
  DatabaseIcon,
  DatabaseTableViewIcon,
  ImportIcon,
  JournalIcon,
  PlusIcon,
} from "@myoxus/icons/react";
import { track } from "@myoxus/track";
import type { DocMode } from "@virgultum/editor/model";

import type { useNavigateHelper } from "../components/hooks/use-navigate-helper";
import type { usePageHelper } from "../editor/virgultum/page-list/utils";
import type { GlobalDialogService } from "../modules/dialogs";
import { registerMyoxusCommand } from "./registry";

export const CURATED_WORKSPACE_COMMAND_IDS = [
  "myoxus:new-page",
  "myoxus:new-edgeless-page",
  "myoxus:today-journal",
  "myoxus:new-database",
  "myoxus:new-project",
  "myoxus:import-workspace",
] as const;

export function registerMyoxusCreationCommands({
  canCreateDatabase,
  canCreateDocument,
  pageHelper,
  t,
  globalDialogService,
  openDatabaseCreation,
  openProjectCreation,
  openTodayJournal,
  jumpToPage,
}: {
  canCreateDatabase: boolean;
  canCreateDocument: boolean;
  t: ReturnType<typeof useI18n>;
  pageHelper: ReturnType<typeof usePageHelper>;
  globalDialogService: GlobalDialogService;
  openDatabaseCreation: () => void;
  openProjectCreation: () => void;
  openTodayJournal: () => void;
  jumpToPage: ReturnType<typeof useNavigateHelper>["jumpToPage"];
}) {
  const unsubs: Array<() => void> = [];
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:new-page",
      category: "myoxus:creation",
      label: t["com.myoxus.cmdk.new-page"](),
      icon: <PlusIcon />,
      preconditionStrategy: () => canCreateDocument,
      keyBinding: BUILD_CONFIG.isElectron
        ? {
            binding: "$mod+N",
            skipRegister: true,
          }
        : undefined,
      run() {
        track.$.cmdk.creation.createDoc({ mode: "page" });

        pageHelper.createPage("page" as DocMode);
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:new-edgeless-page",
      category: "myoxus:creation",
      icon: <PlusIcon />,
      label: t["com.myoxus.cmdk.new-edgeless-page"](),
      preconditionStrategy: () => canCreateDocument,
      run() {
        track.$.cmdk.creation.createDoc({
          mode: "edgeless",
        });

        pageHelper.createEdgeless();
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:today-journal",
      category: "myoxus:creation",
      icon: <JournalIcon />,
      label: t["com.myoxus.command-center.today-journal"](),
      preconditionStrategy: () => canCreateDocument,
      run: openTodayJournal,
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:new-database",
      category: "myoxus:creation",
      icon: <DatabaseTableViewIcon />,
      label: t["com.myoxus.database.create.database"](),
      preconditionStrategy: () => canCreateDatabase,
      run: openDatabaseCreation,
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:new-project",
      category: "myoxus:creation",
      icon: <DatabaseIcon />,
      label: t["com.myoxus.database.create.project"](),
      preconditionStrategy: () => canCreateDatabase,
      run: openProjectCreation,
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:new-workspace",
      category: "myoxus:creation",
      icon: <PlusIcon />,
      label: t["com.myoxus.cmdk.new-workspace"](),
      run() {
        track.$.cmdk.workspace.createWorkspace();

        globalDialogService.open("create-workspace", {}, (payload) => {
          if (payload)
            jumpToPage(payload.metadata.id, payload.defaultDocId ?? "home");
        });
      },
    }),
  );
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:import-workspace",
      category: "myoxus:creation",
      icon: <ImportIcon />,
      label: t["com.myoxus.cmdk.import-workspace"](),
      run() {
        track.$.cmdk.workspace.createWorkspace({
          control: "import",
        });

        globalDialogService.open("import-workspace", undefined);
      },
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}
