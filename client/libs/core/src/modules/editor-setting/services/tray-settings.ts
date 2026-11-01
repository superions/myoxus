import {
  MenubarStateKey,
  type MenubarStateSchema,
} from "@myoxus/desktop-api-contract";
import { LiveData, Service } from "@myoxus/infra";
import { defaults } from "lodash-es";

import type { GlobalStateService } from "../../storage";

const MENUBAR_SETTING_KEY = MenubarStateKey;

const defaultTraySetting: MenubarStateSchema = {
  enabled: true,
  minimizeToTray: false,
  closeToTray: false,
  startMinimized: false,
  openOnLeftClick: false,
};

export class TraySettingService extends Service {
  constructor(private readonly globalStateService: GlobalStateService) {
    super();
  }

  readonly settings$ = LiveData.computed((get) => {
    const value = get(
      LiveData.from(
        this.globalStateService.globalState.watch<MenubarStateSchema>(
          MENUBAR_SETTING_KEY,
        ),
        undefined,
      ),
    );
    return defaults(value, defaultTraySetting);
  });

  get settings() {
    return this.settings$.value;
  }

  setEnabled(enabled: boolean) {
    this.globalStateService.globalState.set(MENUBAR_SETTING_KEY, {
      ...this.settings$.value,
      enabled: enabled,
    });
  }

  setMinimizeToTray(minimizeToTray: boolean) {
    this.globalStateService.globalState.set(MENUBAR_SETTING_KEY, {
      ...this.settings$.value,
      minimizeToTray: minimizeToTray,
    });
  }

  setCloseToTray(closeToTray: boolean) {
    this.globalStateService.globalState.set(MENUBAR_SETTING_KEY, {
      ...this.settings$.value,
      closeToTray: closeToTray,
    });
  }

  setStartMinimized(startMinimized: boolean) {
    this.globalStateService.globalState.set(MENUBAR_SETTING_KEY, {
      ...this.settings$.value,
      startMinimized: startMinimized,
    });
  }

  setOpenOnLeftClick(openOnLeftClick: boolean) {
    this.globalStateService.globalState.set(MENUBAR_SETTING_KEY, {
      ...this.settings$.value,
      openOnLeftClick: openOnLeftClick,
    });
  }
}
