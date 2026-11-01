import { ThemeProvider } from "@myoxus/core/components/theme-provider";
import { configureElectronStateStorageImpls } from "@myoxus/core/desktop/storage";
import { configureCommonShellModules } from "@myoxus/core/modules";
import { configureDesktopApiModule } from "@myoxus/core/modules/desktop-api";
import { I18nProvider } from "@myoxus/core/modules/i18n";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import { Framework, FrameworkRoot } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";

import * as styles from "./app.styles";
import { Recording } from "./recording";

const framework = new Framework();
// Theme and locale providers consume account preferences. Reuse the Shell's
// registered-server graph instead of an incomplete popup-only service graph.
configureCommonShellModules(framework);
configureElectronStateStorageImpls(framework);
configureDesktopApiModule(framework);
const frameworkProvider = framework.provider();

const mode = getDesktopBridge()?.appInfo.windowName as
  "notification" | "recording" | undefined;

export function App() {
  return (
    <FrameworkRoot framework={frameworkProvider}>
      <ThemeProvider>
        <MyoxusUIProvider>
          <I18nProvider>
            <div
              className={styles.root}
              data-is-windows={environment.isWindows}
            >
              {mode === "recording" && <Recording />}
            </div>
          </I18nProvider>
        </MyoxusUIProvider>
      </ThemeProvider>
    </FrameworkRoot>
  );
}
