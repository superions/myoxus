// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { DefaultTheme } from "@virgultum/editor/model";
import { useCallback, useMemo } from "react";

import { MenuItem, SettingsRow, SettingsSection } from "../../../primitives";
import { DropdownMenu, DropdownTrigger, EditorSlider } from "../menu";
import { colorsEqual, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessStylePreview } from "./preview";

const THICKNESS_NODES = [2, 4, 6, 8, 10, 12];

export const PenSettings = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const { brush } = settings;

  const { palettes, getCurrentColor } = usePalettes(
    DefaultTheme.StrokeColorShortPalettes,
    DefaultTheme.black,
  );
  const currentColor = getCurrentColor(brush.color);

  const colorItems = useMemo(
    () =>
      palettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => {
            editorSetting.set("brush", { color: value });
          }}
          selected={colorsEqual(brush.color, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [brush.color, editorSetting, palettes],
  );

  const setThickness = useCallback(
    (value: number[]) => {
      editorSetting.set("brush", { lineWidth: value[0] });
    },
    [editorSetting],
  );

  const title = t["com.myoxus.settings.editorSettings.edgeless.pen"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-pen"
    >
      <EdgelessStylePreview
        items={[
          ...(currentColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.pen.color"
                    ](),
                  value: currentColor.label,
                  color: currentColor.resolvedValue,
                },
              ]
            : []),
          {
            label:
              t["com.myoxus.settings.editorSettings.edgeless.pen.thickness"](),
            value: `${brush.lineWidth}px`,
          },
        ]}
      />
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.pen.color"]()}
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
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.pen.thickness"]()}
        desc=""
      >
        <EditorSlider
          value={[brush.lineWidth]}
          onValueChange={setThickness}
          min={2}
          max={12}
          step={2}
          nodes={THICKNESS_NODES}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
