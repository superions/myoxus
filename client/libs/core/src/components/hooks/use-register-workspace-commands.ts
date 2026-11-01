import { useUserPreferencesService } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useJournalRouteHelper } from "@myoxus/core/components/hooks/use-journal";
import { AppSidebarService } from "@myoxus/core/modules/app-sidebar";
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import {
  GlobalDialogService,
  WorkspaceDialogService,
} from "@myoxus/core/modules/dialogs";
import { I18nService } from "@myoxus/core/modules/i18n";
import { UrlService } from "@myoxus/core/modules/url";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useService, useServiceOptional, useServices } from "@myoxus/infra";
import { useMyoxusTheme } from "@myoxus/ui-facade/provider";
import { useStore } from "jotai";
import { useEffect } from "react";

import {
  PreconditionStrategy,
  registerMyoxusCreationCommands,
  registerMyoxusHelpCommands,
  registerMyoxusLanguageCommands,
  registerMyoxusLayoutCommands,
  registerMyoxusNavigationCommands,
  registerMyoxusSettingsCommands,
  registerMyoxusUpdatesCommands,
  registerMyoxusCommand,
} from "../../commands";
import { usePageHelper } from "../../editor/virgultum/page-list/utils";
import { EditorSettingService } from "../../modules/editor-setting";
import { CMDKQuickSearchService } from "../../modules/quicksearch/services/cmdk";
import { useGuard } from "../guard/use-guard";
import { useNavigateHelper } from "./use-navigate-helper";

function registerCMDKCommand(service: CMDKQuickSearchService) {
  return registerMyoxusCommand({
    id: "myoxus:show-quick-search",
    preconditionStrategy: PreconditionStrategy.Never,
    category: "myoxus:general",
    keyBinding: {
      binding: "$mod+K",
    },
    label: "",
    icon: "",
    run() {
      service.toggle();
    },
  });
}

export function useRegisterWorkspaceCommands() {
  const store = useStore();
  const t = useI18n();
  const theme = useMyoxusTheme();
  const currentWorkspace = useService(WorkspaceService).workspace;
  const canCreateDocument = useGuard("Workspace_CreateDoc");
  const userPreferencesService = useUserPreferencesService();
  const urlService = useService(UrlService);
  const pageHelper = usePageHelper(currentWorkspace.docCollection);
  const navigationHelper = useNavigateHelper();
  const { openToday } = useJournalRouteHelper();
  const {
    cMDKQuickSearchService,
    editorSettingService,
    workspaceDialogService,
    globalDialogService,
    appSidebarService,
    i18nService,
  } = useServices({
    CMDKQuickSearchService,
    EditorSettingService,
    WorkspaceDialogService,
    GlobalDialogService,
    AppSidebarService,
    I18nService,
  });

  const i18n = i18nService.i18n;

  const desktopApiService = useServiceOptional(DesktopApiService);
  const workbenchService = useServiceOptional(WorkbenchService);

  const quitAndInstall = desktopApiService?.handler.updater.quitAndInstall;

  useEffect(() => {
    const unsub = registerCMDKCommand(cMDKQuickSearchService);

    return () => {
      unsub();
    };
  }, [cMDKQuickSearchService]);

  // Register Myoxus update commands.
  useEffect(() => {
    if (!quitAndInstall) {
      return;
    }

    const unsub = registerMyoxusUpdatesCommands({
      store,
      t,
      quitAndInstall,
    });

    return () => {
      unsub();
    };
  }, [quitAndInstall, store, t]);

  // Register Myoxus navigation commands.
  useEffect(() => {
    const unsub = registerMyoxusNavigationCommands({
      t,
      docCollection: currentWorkspace.docCollection,
      navigationHelper,
      workspaceDialogService,
      workbenchService,
    });

    return () => {
      unsub();
    };
  }, [
    store,
    t,
    currentWorkspace.docCollection,
    navigationHelper,
    globalDialogService,
    workspaceDialogService,
    workbenchService,
  ]);

  // Register Myoxus settings commands.
  useEffect(() => {
    const unsub = registerMyoxusSettingsCommands({
      store,
      t,
      theme,
      editorSettingService,
      userPreferencesService,
    });

    return () => {
      unsub();
    };
  }, [editorSettingService, store, t, theme, userPreferencesService]);

  useEffect(() => {
    const unsub = registerMyoxusLanguageCommands({
      i18n,
      t,
      userPreferencesService,
    });

    return () => {
      unsub();
    };
  }, [i18n, t, userPreferencesService]);

  // Register Myoxus layout commands.
  useEffect(() => {
    const unsub = registerMyoxusLayoutCommands({ t, appSidebarService });

    return () => {
      unsub();
    };
  }, [appSidebarService, store, t]);

  // Register Myoxus creation commands.
  useEffect(() => {
    const openDatabaseCreation = () => {
      workbenchService?.workbench.open("/databases?create=database", {
        at: "active",
      });
    };
    const openProjectCreation = () => {
      workbenchService?.workbench.open("/databases?create=project", {
        at: "active",
      });
    };
    const unsub = registerMyoxusCreationCommands({
      canCreateDatabase:
        currentWorkspace.flavour !== "local" &&
        canCreateDocument &&
        Boolean(workbenchService),
      canCreateDocument,
      globalDialogService,
      jumpToPage: navigationHelper.jumpToPage,
      openDatabaseCreation,
      openProjectCreation,
      openTodayJournal: () => openToday({ at: "active" }),
      pageHelper: pageHelper,
      t,
    });

    return () => {
      unsub();
    };
  }, [
    canCreateDocument,
    currentWorkspace.flavour,
    globalDialogService,
    navigationHelper.jumpToPage,
    openToday,
    pageHelper,
    store,
    t,
    workbenchService,
  ]);

  // Register Myoxus help commands.
  useEffect(() => {
    const unsub = registerMyoxusHelpCommands({
      t,
      urlService,
      workspaceDialogService,
    });

    return () => {
      unsub();
    };
  }, [t, globalDialogService, urlService, workspaceDialogService]);
}
