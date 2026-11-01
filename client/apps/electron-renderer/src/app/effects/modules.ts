import { configureElectronStateStorageImpls } from "@myoxus/core/desktop/storage";
import { configureCommonModules } from "@myoxus/core/modules";
import { configureAppTabsHeaderModule } from "@myoxus/core/modules/app-tabs-header";
import { configureDesktopBackupModule } from "@myoxus/core/modules/backup";
import {
  configureDesktopApiModule,
  DesktopApiService,
} from "@myoxus/core/modules/desktop-api";
import {
  configureSpellCheckSettingModule,
  configureTraySettingModule,
} from "@myoxus/core/modules/editor-setting";
import { configureFindInPageModule } from "@myoxus/core/modules/find-in-page";
import { ValidatorProvider } from "@myoxus/core/modules/server";
import {
  ClientSchemeProvider,
  PopupWindowProvider,
} from "@myoxus/core/modules/url";
import { configureDesktopWorkbenchModule } from "@myoxus/core/modules/workbench";
import { configureBrowserWorkspaceFlavours } from "@myoxus/core/modules/workspace-engine";
import { Framework } from "@myoxus/infra";

export function setupModules() {
  const framework = new Framework();
  configureCommonModules(framework);
  configureElectronStateStorageImpls(framework);
  configureBrowserWorkspaceFlavours(framework);
  configureDesktopWorkbenchModule(framework);
  configureAppTabsHeaderModule(framework);
  configureFindInPageModule(framework);
  configureDesktopApiModule(framework);
  configureSpellCheckSettingModule(framework);
  configureTraySettingModule(framework);
  configureDesktopBackupModule(framework);

  framework.impl(PopupWindowProvider, (p) => {
    const apis = p.get(DesktopApiService).api;
    return {
      open: (url: string) => {
        apis.handler.ui.openExternal(url).catch((e) => {
          console.error("Failed to open external URL", e);
        });
      },
    };
  });
  framework.impl(ClientSchemeProvider, (p) => {
    const appInfo = p.get(DesktopApiService).appInfo;
    return {
      getClientScheme() {
        return appInfo?.scheme;
      },
    };
  });
  framework.impl(ValidatorProvider, (p) => {
    const apis = p.get(DesktopApiService).api;
    return {
      async validate(_challenge, resource) {
        const token = await apis.handler.ui.getChallengeResponse(resource);
        if (!token) {
          throw new Error("Challenge failed");
        }
        return token;
      },
    };
  });

  const frameworkProvider = framework.provider();

  return { framework, frameworkProvider };
}
