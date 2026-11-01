import { TraySettingService } from "@myoxus/core/modules/editor-setting/services/tray-settings";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  type MyoxusThemeMode,
  useMyoxusTheme,
} from "@myoxus/ui-facade/provider";
import { useCallback, useMemo } from "react";

import { useDeviceSettingHelper } from "../../../../../components/hooks/myoxus/use-device-setting-helper";
import { useUserPreferences } from "../../../../../components/hooks/myoxus/use-user-preferences";
import {
  MyoxusSegmentedControl,
  MyoxusSwitch,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../primitives";
import { OpenInAppLinksMenu } from "./links";
import { PersonalWorkspaceThemeSettings } from "./personal-workspace-theme";

export const getThemeOptions = (t: ReturnType<typeof useI18n>) => [
  {
    value: "system",
    label: t["com.myoxus.themeSettings.system"](),
    testId: "system-theme-trigger",
  },
  {
    value: "light",
    label: t["com.myoxus.themeSettings.light"](),
    testId: "light-theme-trigger",
  },
  {
    value: "dark",
    label: t["com.myoxus.themeSettings.dark"](),
    testId: "dark-theme-trigger",
  },
];

export const ThemeSettings = () => {
  const t = useI18n();
  const { setTheme, theme } = useMyoxusTheme();
  const { updatePreferences } = useUserPreferences();

  const themeItems = useMemo(() => getThemeOptions(t), [t]);

  return (
    <MyoxusSegmentedControl
      data={themeItems}
      value={theme}
      testId="appearance-theme-segmented-control"
      onChange={useCallback(
        (value: string) => {
          setTheme(value as MyoxusThemeMode);
          void updatePreferences({ colorMode: value });
        },
        [setTheme, updatePreferences],
      )}
    />
  );
};

const MenubarSetting = () => {
  const t = useI18n();
  const traySettingService = useService(TraySettingService);
  const traySetting = useLiveData(traySettingService.settings$);

  return (
    <>
      <SettingsSection
        id="menubar"
        title={t["com.myoxus.appearanceSettings.menubar.title"]()}
      >
        <SettingsRow
          name={t["com.myoxus.appearanceSettings.menubar.toggle"]()}
          desc={t["com.myoxus.appearanceSettings.menubar.description"]()}
        >
          <MyoxusSwitch
            checked={traySetting.enabled}
            onChange={(checked) => traySettingService.setEnabled(checked)}
          />
        </SettingsRow>
      </SettingsSection>
      {traySetting.enabled && !environment.isMacOs ? (
        <SettingsSection
          id="windowBehavior"
          title={t[
            "com.myoxus.appearanceSettings.menubar.windowBehavior.title"
          ]()}
        >
          <SettingsRow
            name={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.openOnLeftClick.toggle"
            ]()}
            desc={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.openOnLeftClick.description"
            ]()}
          >
            <MyoxusSwitch
              checked={traySetting.openOnLeftClick}
              onChange={(checked) =>
                traySettingService.setOpenOnLeftClick(checked)
              }
            />
          </SettingsRow>
          <SettingsRow
            name={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.minimizeToTray.toggle"
            ]()}
            desc={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.minimizeToTray.description"
            ]()}
          >
            <MyoxusSwitch
              checked={traySetting.minimizeToTray}
              onChange={(checked) =>
                traySettingService.setMinimizeToTray(checked)
              }
            />
          </SettingsRow>
          <SettingsRow
            name={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.closeToTray.toggle"
            ]()}
            desc={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.closeToTray.description"
            ]()}
          >
            <MyoxusSwitch
              checked={traySetting.closeToTray}
              onChange={(checked) => traySettingService.setCloseToTray(checked)}
            />
          </SettingsRow>
          <SettingsRow
            name={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.startMinimized.toggle"
            ]()}
            desc={t[
              "com.myoxus.appearanceSettings.menubar.windowBehavior.startMinimized.description"
            ]()}
          >
            <MyoxusSwitch
              checked={traySetting.startMinimized}
              onChange={(checked) =>
                traySettingService.setStartMinimized(checked)
              }
            />
          </SettingsRow>
        </SettingsSection>
      ) : null}
    </>
  );
};

export const AppearanceSettings = () => {
  const t = useI18n();

  const { deviceSettings, updateSettings } = useDeviceSettingHelper();
  const { effectivePreferences, updatePreferences } = useUserPreferences();

  return (
    <SettingsPage
      title={t["com.myoxus.appearanceSettings.title"]()}
      subtitle={t["com.myoxus.appearanceSettings.subtitle"]()}
      testId="settings-page-appearance"
    >
      <SettingsSection title={t["com.myoxus.appearanceSettings.theme.title"]()}>
        <SettingsRow
          name={t["com.myoxus.appearanceSettings.color.title"]()}
          desc={t["com.myoxus.appearanceSettings.color.description"]()}
        >
          <ThemeSettings />
        </SettingsRow>
        <PersonalWorkspaceThemeSettings />
      </SettingsSection>

      <SettingsSection
        title={t["com.myoxus.appearanceSettings.images.title"]()}
      >
        <SettingsRow
          name={t["com.myoxus.appearanceSettings.images.antialiasing.title"]()}
          desc={t[
            "com.myoxus.appearanceSettings.images.antialiasing.description"
          ]()}
          testId="image-antialiasing-trigger"
        >
          <MyoxusSwitch
            checked={effectivePreferences?.imageAntialiasing ?? true}
            onChange={(checked) =>
              void updatePreferences({ imageAntialiasing: checked })
            }
          />
        </SettingsRow>
      </SettingsSection>

      {BUILD_CONFIG.isWeb && !environment.isMobile ? (
        <SettingsSection title={t["com.myoxus.setting.appearance.links"]()}>
          <SettingsRow
            name={t["com.myoxus.setting.appearance.open-in-app"]()}
            desc={t["com.myoxus.setting.appearance.open-in-app.hint"]()}
            testId="open-in-app-links-trigger"
          >
            <OpenInAppLinksMenu />
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t["com.myoxus.appearanceSettings.sidebar.title"]()}
      >
        {BUILD_CONFIG.isElectron ? (
          <SettingsRow
            name={t["com.myoxus.appearanceSettings.noisyBackground.title"]()}
            desc={t[
              "com.myoxus.appearanceSettings.noisyBackground.description"
            ]()}
          >
            <MyoxusSwitch
              checked={effectivePreferences?.noisyBackground ?? true}
              onChange={(checked) =>
                void updatePreferences({ noisyBackground: checked })
              }
            />
          </SettingsRow>
        ) : null}
        {BUILD_CONFIG.isElectron && environment.isMacOs ? (
          <SettingsRow
            name={t["com.myoxus.appearanceSettings.translucentUI.title"]()}
            desc={t[
              "com.myoxus.appearanceSettings.translucentUI.description"
            ]()}
          >
            <MyoxusSwitch
              checked={deviceSettings.enableBlurBackground}
              onChange={(checked) =>
                updateSettings("enableBlurBackground", checked)
              }
            />
          </SettingsRow>
        ) : null}
        <SettingsRow
          name={t[
            "com.myoxus.appearanceSettings.showLinkedDocInSidebar.title"
          ]()}
          desc={t[
            "com.myoxus.appearanceSettings.showLinkedDocInSidebar.description"
          ]()}
        >
          <MyoxusSwitch
            checked={effectivePreferences?.showLinkedDocuments ?? true}
            onChange={(checked) =>
              void updatePreferences({ showLinkedDocuments: checked })
            }
          />
        </SettingsRow>
      </SettingsSection>

      {BUILD_CONFIG.isElectron ? <MenubarSetting /> : null}
    </SettingsPage>
  );
};
