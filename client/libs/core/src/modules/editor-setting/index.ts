import { type Framework } from "@myoxus/infra";

import { DesktopApiService } from "../desktop-api";
import { DocCreateMiddleware } from "../doc";
import { GlobalContextService } from "../global-context";
import { I18n } from "../i18n";
import { DefaultServerService, ServersService } from "../server";
import { GlobalState, GlobalStateService } from "../storage";
import { AppThemeService } from "../theme";
import { WorkspaceScope } from "../workspace";
import { EditorSetting } from "./entities/editor-setting";
import { EditorSettingDocCreateMiddleware } from "./impls/doc-create-middleware";
import { UserPreferencesEditorSettingProvider } from "./impls/user-preferences";
import { EditorSettingProvider } from "./provider/editor-setting-provider";
import { EditorSettingService } from "./services/editor-setting";
import { SpellCheckSettingService } from "./services/spell-check-setting";
import { TraySettingService } from "./services/tray-settings";
export {
  edgelessTextSizeOptions,
  EditorSettingSchema,
  formatEdgelessTextSizeLabel,
} from "./schema";
export { EditorSettingService } from "./services/editor-setting";

export function configureEditorSettingModule(framework: Framework) {
  framework
    .service(EditorSettingService)
    .entity(EditorSetting, [EditorSettingProvider])
    .impl(EditorSettingProvider, UserPreferencesEditorSettingProvider, [
      ServersService,
      DefaultServerService,
      GlobalContextService,
      GlobalState,
    ])
    .scope(WorkspaceScope)
    .impl(DocCreateMiddleware, EditorSettingDocCreateMiddleware, [
      EditorSettingService,
      AppThemeService,
    ]);
}

export function configureSpellCheckSettingModule(framework: Framework) {
  framework.service(SpellCheckSettingService, [
    GlobalStateService,
    I18n,
    DesktopApiService,
  ]);
}

export function configureTraySettingModule(framework: Framework) {
  framework.service(TraySettingService, [GlobalStateService]);
}
