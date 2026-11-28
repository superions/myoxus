// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { DefaultTheme } from "@virgultum/editor/model";
import { useMemo } from "react";

import { MenuItem, SettingsRow, SettingsSection } from "../../../primitives";
import { DropdownMenu, DropdownTrigger } from "../menu";
import { colorsEqual, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessStylePreview } from "./preview";

const FRAME_PALETTES = [
  { key: "Transparent", value: DefaultTheme.transparent },
  ...DefaultTheme.FillColorShortPalettes,
];

export const FrameSettings = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { background } = settings["myoxus:frame"];

  const { palettes, getCurrentColor } = usePalettes(
    FRAME_PALETTES,
    DefaultTheme.transparent,
  );
  const currentColor = getCurrentColor(background);

  const colorItems = useMemo(
    () =>
      palettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => {
            editorSetting.set("myoxus:frame", { background: value });
          }}
          selected={colorsEqual(background, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [background, editorSetting, palettes],
  );

  const title = t["com.myoxus.settings.editorSettings.edgeless.frame"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-frame"
    >
      <EdgelessStylePreview
        sampleTitle={t[
          "com.myoxus.settings.editorSettings.edgeless.preview.common.frame"
        ]()}
        items={
          currentColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.frame.background"
                    ](),
                  value: currentColor.label,
                  color: currentColor.resolvedValue,
                },
              ]
            : []
        }
      />
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.frame.background"
        ]()}
        desc=""
      >
        {currentColor ? (
          <DropdownMenu
            items={colorItems}
            trigger={
              <DropdownTrigger
                prefix={<Point color={currentColor.resolvedValue} />}
              >
                {currentColor.label}
              </DropdownTrigger>
            }
          />
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
};
