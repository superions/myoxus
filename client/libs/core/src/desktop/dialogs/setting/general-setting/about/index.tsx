import { useAppUpdater } from "@myoxus/core/components/hooks/use-app-updater";
import { appNames } from "@myoxus/core/utils/channel";
import { useI18n } from "@myoxus/i18n";
import { ArrowRightSmallIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { useCallback } from "react";

import AboutMyoxusLogo from "../../../../../../../../../assets/branding/myoxus_text.svg";
import { useDeviceSettingHelper } from "../../../../../components/hooks/myoxus/use-device-setting-helper";
import { useUserPreferences } from "../../../../../components/hooks/myoxus/use-user-preferences";
import { UrlService } from "../../../../../modules/url";
import {
  MyoxusSwitch,
  SettingsControlGroup,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../../primitives";
import { UpdateCheckSection } from "./update-check-section";

export const AboutMyoxus = () => {
  const t = useI18n();
  const { deviceSettings } = useDeviceSettingHelper();
  const { effectivePreferences, updatePreferences } = useUserPreferences();
  const {
    toggleAutoCheck,
    toggleAutoDownload,
    updaterState,
    externalMacosInstall,
    currentVersion,
  } = useAppUpdater();
  const urlService = useService(UrlService);
  const channel = BUILD_CONFIG.appBuildType;
  const appName = appNames[channel];

  const onSwitchAutoCheck = useCallback(
    (checked: boolean) => {
      toggleAutoCheck(checked);
    },
    [toggleAutoCheck],
  );

  const onSwitchAutoDownload = useCallback(
    (checked: boolean) => {
      toggleAutoDownload(checked);
    },
    [toggleAutoDownload],
  );

  const onSwitchTelemetry = useCallback(
    (checked: boolean) => {
      void updatePreferences({ telemetryEnabled: checked });
    },
    [updatePreferences],
  );

  return (
    <SettingsPage
      title={t["com.myoxus.aboutMyoxus.title"]()}
      subtitle={t["com.myoxus.aboutMyoxus.subtitle"]()}
      testId="settings-page-about"
    >
      <SettingsSection title={t["com.myoxus.aboutMyoxus.version.title"]()}>
        <SettingsRow
          name={appName}
          desc={currentVersion ?? BUILD_CONFIG.appVersion}
        >
          <SettingsControlGroup>
            <img
              src={AboutMyoxusLogo}
              alt={`${appName} logo`}
              width={168}
              height={95}
              loading="eager"
              decoding="async"
            />
          </SettingsControlGroup>
        </SettingsRow>
        <SettingsRow
          name={t["com.myoxus.aboutMyoxus.version.editor.title"]()}
          desc={BUILD_CONFIG.editorVersion}
        />
        {BUILD_CONFIG.isElectron ? (
          <>
            <UpdateCheckSection />
            {updaterState && !externalMacosInstall ? (
              <>
                <SettingsRow
                  name={t["com.myoxus.aboutMyoxus.autoCheckUpdate.title"]()}
                  desc={t[
                    "com.myoxus.aboutMyoxus.autoCheckUpdate.description"
                  ]()}
                >
                  <MyoxusSwitch
                    checked={deviceSettings.autoCheckUpdate}
                    onChange={onSwitchAutoCheck}
                  />
                </SettingsRow>
                <SettingsRow
                  name={t["com.myoxus.aboutMyoxus.autoDownloadUpdate.title"]()}
                  desc={t[
                    "com.myoxus.aboutMyoxus.autoDownloadUpdate.description"
                  ]()}
                >
                  <MyoxusSwitch
                    checked={deviceSettings.autoDownloadUpdate}
                    onChange={onSwitchAutoDownload}
                  />
                </SettingsRow>
              </>
            ) : null}
            <SettingsRow
              name={t["com.myoxus.aboutMyoxus.changelog.title"]()}
              desc={t["com.myoxus.aboutMyoxus.changelog.description"]()}
              onClick={() => {
                urlService.openPopupWindow(BUILD_CONFIG.changelogUrl);
              }}
            >
              <ArrowRightSmallIcon />
            </SettingsRow>
          </>
        ) : null}
        <SettingsRow
          name={t["com.myoxus.telemetry.enable"]()}
          desc={t["com.myoxus.telemetry.enable.desc"]()}
        >
          <MyoxusSwitch
            checked={effectivePreferences?.telemetryEnabled ?? true}
            onChange={onSwitchTelemetry}
          />
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  );
};
