// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import type { EdgelessDefaultTheme } from "@myoxus/core/modules/editor-setting/schema";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useMemo } from "react";

import { Menu, MenuItem, SettingsRow, Switch } from "../../../primitives";
import { DropdownTrigger } from "../menu";

export const GeneralEdgelessSetting = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { edgelessDefaultTheme, edgelessScrollZoom } = settings;

  const themeOptions = useMemo<
    Array<{ value: EdgelessDefaultTheme; label: string }>
  >(
    () => [
      {
        value: "specified",
        label:
          t[
            "com.myoxus.settings.editorSettings.page.edgeless-default-theme.specified"
          ](),
      },
      {
        value: "dark",
        label: t["com.myoxus.themeSettings.dark"](),
      },
      {
        value: "light",
        label: t["com.myoxus.themeSettings.light"](),
      },
      {
        value: "auto",
        label: t["com.myoxus.themeSettings.auto"](),
      },
    ],
    [t],
  );

  const currentThemeLabel =
    themeOptions.find((option) => option.value === edgelessDefaultTheme)
      ?.label ?? "";

  const menuItems = useMemo(
    () =>
      themeOptions.map((option) => (
        <MenuItem
          key={option.value}
          selected={edgelessDefaultTheme === option.value}
          onSelect={() => {
            editorSetting.set("edgelessDefaultTheme", option.value);
          }}
        >
          {option.label}
        </MenuItem>
      )),
    [edgelessDefaultTheme, editorSetting, themeOptions],
  );

  const handleScrollZoomChange = useCallback(
    (checked: boolean) => {
      editorSetting.set("edgelessScrollZoom", checked);
    },
    [editorSetting],
  );

  return (
    <>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.page.edgeless-default-theme.title"
        ]()}
        desc={t[
          "com.myoxus.settings.editorSettings.page.edgeless-default-theme.description"
        ]()}
      >
        <Menu
          items={menuItems}
          contentOptions={{
            align: "end",
            sideOffset: 16,
            panelWidth: "display",
          }}
        >
          <DropdownTrigger tooltip={currentThemeLabel}>
            {currentThemeLabel}
          </DropdownTrigger>
        </Menu>
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.page.edgeless-scroll-wheel-zoom.title"
        ]()}
        desc={t[
          "com.myoxus.settings.editorSettings.page.edgeless-scroll-wheel-zoom.description"
        ]()}
      >
        <Switch
          checked={edgelessScrollZoom}
          onChange={handleScrollZoomChange}
        />
      </SettingsRow>
    </>
  );
};
