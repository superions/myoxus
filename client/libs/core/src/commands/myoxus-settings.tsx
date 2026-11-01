import type { useI18n } from "@myoxus/i18n";
import { SettingsIcon } from "@myoxus/icons/react";
import { deviceSettingAtom } from "@myoxus/infra";
import { track } from "@myoxus/track";
import type { MyoxusThemeContextValue } from "@myoxus/ui-facade/provider";
import type { createStore } from "jotai";

import type { EditorSettingService } from "../modules/editor-setting";
import type { UserPreferencesService } from "../modules/server";
import { registerMyoxusCommand } from "./registry";

export function registerMyoxusSettingsCommands({
  t,
  store,
  theme,
  editorSettingService,
  userPreferencesService,
}: {
  t: ReturnType<typeof useI18n>;
  store: ReturnType<typeof createStore>;
  theme: MyoxusThemeContextValue;
  editorSettingService: EditorSettingService;
  userPreferencesService: UserPreferencesService;
}) {
  const unsubs: Array<() => void> = [];
  const updateSettings = editorSettingService.editorSetting.set.bind(
    editorSettingService.editorSetting,
  );
  const settings$ = editorSettingService.editorSetting.settings$;

  // color modes
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:change-color-mode-to-auto",
      label: `${t["com.myoxus.cmdk.color-mode.to"]()} ${t[
        "com.myoxus.themeSettings.system"
      ]()}`,
      category: "myoxus:settings",
      icon: <SettingsIcon />,
      preconditionStrategy: () => theme.theme !== "system",
      run() {
        track.$.cmdk.settings.changeAppSetting({
          key: "theme",
          value: "system",
        });
        theme.setTheme("system");
        void userPreferencesService.update({ colorMode: "system" });
      },
    }),
  );
  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:change-color-mode-to-dark",
      label: `${t["com.myoxus.cmdk.color-mode.to"]()} ${t[
        "com.myoxus.themeSettings.dark"
      ]()}`,
      category: "myoxus:settings",
      icon: <SettingsIcon />,
      preconditionStrategy: () => theme.theme !== "dark",
      run() {
        track.$.cmdk.settings.changeAppSetting({
          key: "theme",
          value: "dark",
        });
        theme.setTheme("dark");
        void userPreferencesService.update({ colorMode: "dark" });
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: "myoxus:change-color-mode-to-light",
      label: `${t["com.myoxus.cmdk.color-mode.to"]()} ${t[
        "com.myoxus.themeSettings.light"
      ]()}`,
      category: "myoxus:settings",
      icon: <SettingsIcon />,
      preconditionStrategy: () => theme.theme !== "light",
      run() {
        track.$.cmdk.settings.changeAppSetting({
          key: "theme",
          value: "light",
        });

        theme.setTheme("light");
        void userPreferencesService.update({ colorMode: "light" });
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: `affine:change-full-width-layout`,
      label: () =>
        `${t[
          settings$.value.fullWidthLayout
            ? "com.myoxus.cmdk.default-page-width-layout.standard"
            : "com.myoxus.cmdk.default-page-width-layout.full-width"
        ]()}`,
      category: "myoxus:settings",
      icon: <SettingsIcon />,
      run() {
        track.$.cmdk.settings.changeAppSetting({
          key: "fullWidthLayout",
          value: settings$.value.fullWidthLayout ? "off" : "on",
        });
        updateSettings("fullWidthLayout", !settings$.value.fullWidthLayout);
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: `affine:change-noise-background-on-the-sidebar`,
      label: () =>
        `${t["com.myoxus.cmdk.noise-background-on-the-sidebar.to"]()} ${t[
          userPreferencesService.userPreferences$.value?.effectiveValues
            .noisyBackground
            ? "com.myoxus.cmdk.switch-state.off"
            : "com.myoxus.cmdk.switch-state.on"
        ]()}`,
      category: "myoxus:settings",
      icon: <SettingsIcon />,
      preconditionStrategy: () => BUILD_CONFIG.isElectron,
      run() {
        track.$.cmdk.settings.changeAppSetting({
          key: "enableNoisyBackground",
          value: userPreferencesService.userPreferences$.value?.effectiveValues
            .noisyBackground
            ? "off"
            : "on",
        });

        const current =
          userPreferencesService.userPreferences$.value?.effectiveValues
            .noisyBackground ?? true;
        void userPreferencesService.update({ noisyBackground: !current });
      },
    }),
  );

  unsubs.push(
    registerMyoxusCommand({
      id: `affine:change-translucent-ui-on-the-sidebar`,
      label: () =>
        `${t["com.myoxus.cmdk.translucent-ui-on-the-sidebar.to"]()} ${t[
          store.get(deviceSettingAtom).enableBlurBackground
            ? "com.myoxus.cmdk.switch-state.off"
            : "com.myoxus.cmdk.switch-state.on"
        ]()}`,
      category: "myoxus:settings",
      icon: <SettingsIcon />,
      preconditionStrategy: () =>
        BUILD_CONFIG.isElectron && environment.isMacOs,
      run() {
        track.$.cmdk.settings.changeAppSetting({
          key: "enableBlurBackground",
          value: store.get(deviceSettingAtom).enableBlurBackground
            ? "off"
            : "on",
        });
        store.set(deviceSettingAtom, (prev) => ({
          ...prev,
          enableBlurBackground: !prev.enableBlurBackground,
        }));
      },
    }),
  );

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}
