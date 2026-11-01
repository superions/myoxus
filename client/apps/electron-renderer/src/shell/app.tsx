import { useDeviceSettingHelper } from "@myoxus/core/components/hooks/myoxus/use-device-setting-helper";
import { ThemeProvider } from "@myoxus/core/components/theme-provider";
import { configureElectronStateStorageImpls } from "@myoxus/core/desktop/storage";
import { configureCommonShellModules } from "@myoxus/core/modules";
import { configureAppSidebarModule } from "@myoxus/core/modules/app-sidebar";
import { ShellAppSidebarFallback } from "@myoxus/core/modules/app-sidebar/views";
import {
  AppTabsHeader,
  configureAppTabsHeaderModule,
} from "@myoxus/core/modules/app-tabs-header";
import { configureDesktopApiModule } from "@myoxus/core/modules/desktop-api";
import { I18nProvider } from "@myoxus/core/modules/i18n";
import { Framework, FrameworkRoot } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";

import { WindowsAppControls } from "../windows-app-controls";
import * as styles from "./app.styles";

const framework = new Framework();
configureCommonShellModules(framework);
configureElectronStateStorageImpls(framework);
configureAppTabsHeaderModule(framework);
configureAppSidebarModule(framework);
configureDesktopApiModule(framework);
const frameworkProvider = framework.provider();

export function App() {
  const { deviceSettings } = useDeviceSettingHelper();
  const translucent =
    BUILD_CONFIG.isElectron &&
    environment.isMacOs &&
    deviceSettings.enableBlurBackground;

  return (
    <FrameworkRoot framework={frameworkProvider}>
      <ThemeProvider>
        <MyoxusUIProvider>
          <I18nProvider>
            <div className={styles.root} data-translucent={translucent}>
              <AppTabsHeader mode="shell" className={styles.appTabsHeader} />
              <div className={styles.body}>
                <ShellAppSidebarFallback />
              </div>
              {environment.isWindows && <WindowsAppControls />}
            </div>
          </I18nProvider>
        </MyoxusUIProvider>
      </ThemeProvider>
    </FrameworkRoot>
  );
}
