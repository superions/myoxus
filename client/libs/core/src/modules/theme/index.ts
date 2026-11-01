export {
  inheritPersonalWorkspaceTheme,
  loadPersonalWorkspaceTheme,
  type PersonalWorkspaceThemeState,
  selectPersonalWorkspaceTheme,
} from "./personal-workspace-theme";
export { AppThemeService } from "./services/theme";

import { type Framework } from "@myoxus/infra";

import { AppTheme } from "./entities/theme";
import { AppThemeService } from "./services/theme";

export function configureAppThemeModule(framework: Framework) {
  framework.service(AppThemeService).entity(AppTheme);
}

export function configureEssentialThemeModule(framework: Framework) {
  framework.service(AppThemeService).entity(AppTheme);
}
