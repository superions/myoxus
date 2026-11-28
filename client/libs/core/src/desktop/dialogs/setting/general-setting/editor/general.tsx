// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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

const DEFAULT_MODE_MENU_OPTIONS = {
  align: "end",
  sideOffset: 16,
  panelWidth: "display",
} as const;

function FontSizeRow() {
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
}

function NewDocDefaultModeRow() {
  const t = useI18n();
  const { editorSettingService } = useServices({ EditorSettingService });
  const settings = useLiveData(editorSettingService.editorSetting.settings$);

  const modes = useMemo(
    () =>
      [
        { value: "page", label: t["Page"](), testId: "page-mode-trigger" },
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

  const handleSelect = useCallback(
    (mode: EditorSettingSchema["newDocDefaultMode"]) => {
      editorSettingService.editorSetting.set("newDocDefaultMode", mode);
    },
    [editorSettingService.editorSetting],
  );

  const activeLabel = modes.find(
    (item) => item.value === settings.newDocDefaultMode,
  )?.label;

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
        contentOptions={DEFAULT_MODE_MENU_OPTIONS}
        items={modes.map((item) => (
          <MenuItem
            key={item.value}
            selected={item.value === settings.newDocDefaultMode}
            onSelect={() => handleSelect(item.value)}
            data-testid={item.testId}
          >
            {item.label}
          </MenuItem>
        ))}
      >
        <DropdownTrigger data-testid="new-doc-default-mode-trigger">
          {activeLabel}
        </DropdownTrigger>
      </Menu>
    </SettingsRow>
  );
}

function AIToggleRow() {
  const t = useI18n();
  const { openConfirmModal } = useConfirmModal();
  const { featureFlagService, serverService } = useServices({
    FeatureFlagService,
    ServerService,
  });
  const serverFeatures = useLiveData(serverService.server.features$);
  const enableAI = useLiveData(featureFlagService.flags.enable_ai.$);

  const handleToggle = useCallback(
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
        onConfirm: () => featureFlagService.flags.enable_ai.set(checked),
        confirmButtonOptions: { variant: checked ? "primary" : "error" },
      });
    },
    [featureFlagService, openConfirmModal, t],
  );

  if (!serverFeatures?.copilot) return null;

  return (
    <SettingsRow
      name={t["com.myoxus.settings.editorSettings.general.ai.title"]()}
      desc={t["com.myoxus.settings.editorSettings.general.ai.description"]()}
    >
      <Switch checked={enableAI} onChange={handleToggle} />
    </SettingsRow>
  );
}

function SpellCheckRow() {
  const t = useI18n();
  const spellCheckSetting = useService(SpellCheckSettingService);
  const desktopApiService = useService(DesktopApiService);
  const enabled = useLiveData(spellCheckSetting.enabled$)?.enabled;
  const [needsRestart, setNeedsRestart] = useState(false);

  const handleToggle = useCallback(
    (checked: boolean) => {
      spellCheckSetting.setEnabled(checked);
      setNeedsRestart(true);
    },
    [spellCheckSetting],
  );

  const handleRestart = useAsyncCallback(async () => {
    await desktopApiService.handler.ui.restartApp();
  }, [desktopApiService]);

  return (
    <SettingsRow
      name={t["com.myoxus.settings.editorSettings.general.spell-check.title"]()}
      desc={
        needsRestart ? (
          <SettingsStatusText tone="error">
            <Trans i18nKey="com.myoxus.settings.editorSettings.general.spell-check.restart-hint">
              Settings changed; please restart the app.
              <InlineActionButton onClick={handleRestart}>
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
      <Switch checked={enabled} onChange={handleToggle} />
    </SettingsRow>
  );
}

function MiddleClickPasteRow() {
  const t = useI18n();
  const editorSetting = useService(EditorSettingService).editorSetting;
  const settings = useLiveData(editorSetting.settings$);

  const handleToggle = useCallback(
    (checked: boolean) => {
      editorSetting.set("enableMiddleClickPaste", checked);
    },
    [editorSetting],
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
        onChange={handleToggle}
      />
    </SettingsRow>
  );
}

export function General() {
  const t = useI18n();

  return (
    <SettingsSection
      title={t["com.myoxus.settings.editorSettings.general"]()}
      testId="editor-settings-section-general"
    >
      <AIToggleRow />
      <FontSizeRow />
      <NewDocDefaultModeRow />
      {BUILD_CONFIG.isElectron ? <SpellCheckRow /> : null}
      {environment.isLinux ? <MiddleClickPasteRow /> : null}
    </SettingsSection>
  );
}
