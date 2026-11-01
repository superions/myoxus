import { EditorReadingSizeSelect } from "@myoxus/core/components/editor-reading-size";
import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import { DesktopApiService } from "@myoxus/core/modules/desktop-api";
import {
  type EditorSettingSchema,
  EditorSettingService,
} from "@myoxus/core/modules/editor-setting";
import { SpellCheckSettingService } from "@myoxus/core/modules/editor-setting/services/spell-check-setting";
import { FeatureFlagService } from "@myoxus/core/modules/feature-flag";
import { ServerService } from "@myoxus/core/modules/server";
import { Trans, useI18n } from "@myoxus/i18n";
import { useLiveData, useService, useServices } from "@myoxus/infra";
import { useCallback, useMemo, useState } from "react";

import {
  InlineActionButton,
  Menu,
  MenuItem,
  SettingsControlGroup,
  SettingsRow,
  SettingsSection,
  SettingsStatusText,
  Switch,
  useConfirmModal,
} from "../../primitives";
import { DropdownTrigger } from "./menu";

const FontSizeSettings = () => {
  const t = useI18n();
  return (
    <SettingsRow
      name={t["com.myoxus.settings.editorSettings.general.font-size.title"]()}
      desc={t[
        "com.myoxus.settings.editorSettings.general.font-size.description"
      ]()}
    >
      <SettingsControlGroup>
        <EditorReadingSizeSelect />
      </SettingsControlGroup>
    </SettingsRow>
  );
};

const menuContentOptions = {
  align: "end",
  sideOffset: 16,
  panelWidth: "display",
} as const;
const NewDocDefaultModeSettings = () => {
  const t = useI18n();
  const { editorSettingService } = useServices({ EditorSettingService });
  const settings = useLiveData(editorSettingService.editorSetting.settings$);
  const items = useMemo(
    () =>
      [
        {
          value: "page",
          label: t["Page"](),
          testId: "page-mode-trigger",
        },
        {
          value: "edgeless",
          label: t["Edgeless"](),
          testId: "edgeless-mode-trigger",
        },
        {
          value: "ask",
          label: t["com.myoxus.settings.editorSettings.ask-me-every-time"](),
          testId: "ask-every-time-trigger",
        },
      ] as const,
    [t],
  );
  const updateNewDocDefaultMode = useCallback(
    (value: EditorSettingSchema["newDocDefaultMode"]) => {
      editorSettingService.editorSetting.set("newDocDefaultMode", value);
    },
    [editorSettingService.editorSetting],
  );
  return (
    <SettingsRow
      name={t[
        "com.myoxus.settings.editorSettings.general.default-new-doc.title"
      ]()}
      desc={t[
        "com.myoxus.settings.editorSettings.general.default-new-doc.description"
      ]()}
    >
      <Menu
        contentOptions={menuContentOptions}
        items={items.map((item) => {
          return (
            <MenuItem
              key={item.value}
              selected={item.value === settings.newDocDefaultMode}
              onSelect={() => updateNewDocDefaultMode(item.value)}
              data-testid={item.testId}
            >
              {item.label}
            </MenuItem>
          );
        })}
      >
        <DropdownTrigger data-testid="new-doc-default-mode-trigger">
          {
            items.find((item) => item.value === settings.newDocDefaultMode)
              ?.label
          }
        </DropdownTrigger>
      </Menu>
    </SettingsRow>
  );
};

const AISettings = () => {
  const t = useI18n();
  const { openConfirmModal } = useConfirmModal();
  const { featureFlagService, serverService } = useServices({
    FeatureFlagService,
    ServerService,
  });
  const serverFeatures = useLiveData(serverService.server.features$);
  const enableAI = useLiveData(featureFlagService.flags.enable_ai.$);

  const onAIChange = useCallback(
    (checked: boolean) => {
      featureFlagService.flags.enable_ai.set(checked); // this will trigger page reload, see `FeatureFlagService`
    },
    [featureFlagService],
  );
  const onToggleAI = useCallback(
    (checked: boolean) => {
      openConfirmModal({
        title: checked
          ? t["com.myoxus.settings.editorSettings.general.ai.enable.title"]()
          : t["com.myoxus.settings.editorSettings.general.ai.disable.title"](),
        description: checked
          ? t[
              "com.myoxus.settings.editorSettings.general.ai.enable.description"
            ]()
          : t[
              "com.myoxus.settings.editorSettings.general.ai.disable.description"
            ](),
        confirmText: checked
          ? t["com.myoxus.settings.editorSettings.general.ai.enable.confirm"]()
          : t[
              "com.myoxus.settings.editorSettings.general.ai.disable.confirm"
            ](),
        cancelText: t["Cancel"](),
        onConfirm: () => onAIChange(checked),
        confirmButtonOptions: {
          variant: checked ? "primary" : "error",
        },
      });
    },
    [openConfirmModal, t, onAIChange],
  );

  if (!serverFeatures?.copilot) {
    return null;
  }

  return (
    <SettingsRow
      name={t["com.myoxus.settings.editorSettings.general.ai.title"]()}
      desc={t["com.myoxus.settings.editorSettings.general.ai.description"]()}
    >
      <Switch checked={enableAI} onChange={onToggleAI} />
    </SettingsRow>
  );
};

const SpellCheckSettings = () => {
  const t = useI18n();
  const spellCheckSetting = useService(SpellCheckSettingService);

  const desktopApiService = useService(DesktopApiService);

  const enabled = useLiveData(spellCheckSetting.enabled$)?.enabled;

  const [requireRestart, setRequireRestart] = useState(false);

  const onToggleSpellCheck = useCallback(
    (checked: boolean) => {
      spellCheckSetting.setEnabled(checked);
      setRequireRestart(true);
    },
    [spellCheckSetting],
  );

  const onRestart = useAsyncCallback(async () => {
    await desktopApiService.handler.ui.restartApp();
  }, [desktopApiService]);

  return (
    <SettingsRow
      name={t["com.myoxus.settings.editorSettings.general.spell-check.title"]()}
      desc={
        requireRestart ? (
          <SettingsStatusText tone="error">
            <Trans i18nKey="com.myoxus.settings.editorSettings.general.spell-check.restart-hint">
              Settings changed; please restart the app.
              <InlineActionButton onClick={onRestart}>
                Restart
              </InlineActionButton>
            </Trans>
          </SettingsStatusText>
        ) : (
          t[
            "com.myoxus.settings.editorSettings.general.spell-check.description"
          ]()
        )
      }
    >
      <Switch checked={enabled} onChange={onToggleSpellCheck} />
    </SettingsRow>
  );
};

const MiddleClickPasteSettings = () => {
  const t = useI18n();
  const editorSettingService = useService(EditorSettingService);
  const settings = useLiveData(editorSettingService.editorSetting.settings$);
  const onToggleMiddleClickPaste = useCallback(
    (checked: boolean) => {
      editorSettingService.editorSetting.set("enableMiddleClickPaste", checked);
    },
    [editorSettingService.editorSetting],
  );
  return (
    <SettingsRow
      name={t[
        "com.myoxus.settings.editorSettings.general.middle-click-paste.title"
      ]()}
      desc={t[
        "com.myoxus.settings.editorSettings.general.middle-click-paste.description"
      ]()}
    >
      <Switch
        checked={settings.enableMiddleClickPaste}
        onChange={onToggleMiddleClickPaste}
      />
    </SettingsRow>
  );
};

export const General = () => {
  const t = useI18n();

  return (
    <SettingsSection
      title={t["com.myoxus.settings.editorSettings.general"]()}
      testId="editor-settings-section-general"
    >
      <AISettings />
      <FontSizeSettings />
      <NewDocDefaultModeSettings />
      {BUILD_CONFIG.isElectron && <SpellCheckSettings />}
      {environment.isLinux && <MiddleClickPasteSettings />}
      {/* // TODO(@akumatus): implement these settings
        <DeFaultCodeBlockSettings />
       */}
    </SettingsSection>
  );
};
