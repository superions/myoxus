// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { TextUtils } from "@virgultum/editor/blocks/surface";
import {
  DefaultTheme,
  FontStyle,
  FontWeightMap,
  TextAlign,
} from "@virgultum/editor/model";
import { useCallback, useMemo } from "react";

import {
  MenuItem,
  type RadioItem,
  SettingsRow,
  SettingsSection,
} from "../../../primitives";
import { DropdownMenu, DropdownTrigger, EditorRadioGroup } from "../menu";
import { colorsEqual, sortedFontWeightEntries, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessStylePreview } from "./preview";

export const TextSettings = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const text = settings["myoxus:edgeless-text"];

  const { palettes, getCurrentColor } = usePalettes(
    DefaultTheme.StrokeColorShortPalettes,
    DefaultTheme.textColor,
  );
  const currentColor = getCurrentColor(text.color);

  const alignItems = useMemo<RadioItem[]>(
    () => [
      {
        value: TextAlign.Left,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.text.alignment.left"
          ](),
      },
      {
        value: TextAlign.Center,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.text.alignment.center"
          ](),
      },
      {
        value: TextAlign.Right,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.text.alignment.right"
          ](),
      },
    ],
    [t],
  );

  const setTextAlign = useCallback(
    (value: TextAlign) => {
      editorSetting.set("myoxus:edgeless-text", { textAlign: value });
    },
    [editorSetting],
  );

  const colorItems = useMemo(
    () =>
      palettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => {
            editorSetting.set("myoxus:edgeless-text", { color: value });
          }}
          selected={colorsEqual(text.color, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [editorSetting, palettes, text.color],
  );

  const currentFontFamily = TextUtils.getFontFamilyName(text.fontFamily);
  const fontFamilyItems = useMemo(
    () =>
      TextUtils.getFontFamilies().map((family) => (
        <MenuItem
          key={family}
          onSelect={() => {
            editorSetting.set("myoxus:edgeless-text", { fontFamily: family });
          }}
          selected={currentFontFamily === family}
        >
          {family}
        </MenuItem>
      )),
    [currentFontFamily, editorSetting],
  );

  const fontStyleItems = useMemo(
    () =>
      Object.entries(FontStyle).map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => {
            editorSetting.set("myoxus:edgeless-text", { fontStyle: value });
          }}
          selected={text.fontStyle === value}
        >
          {name}
        </MenuItem>
      )),
    [editorSetting, text.fontStyle],
  );

  const fontWeightItems = useMemo(
    () =>
      sortedFontWeightEntries.map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => {
            editorSetting.set("myoxus:edgeless-text", { fontWeight: value });
          }}
          selected={text.fontWeight === value}
        >
          {name}
        </MenuItem>
      )),
    [editorSetting, text.fontWeight],
  );

  const currentAlignLabel =
    alignItems.find((item) => item.value === text.textAlign)?.label ??
    text.textAlign;
  const title = t["com.myoxus.settings.editorSettings.edgeless.text"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-text"
    >
      <EdgelessStylePreview
        sampleTitle={`${t["com.myoxus.settings.editorSettings.edgeless.preview.text.to-shape"]()} ${t["com.myoxus.settings.editorSettings.edgeless.preview.text.not-to-adopt"]()}`}
        items={[
          ...(currentColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.text.color"
                    ](),
                  value: currentColor.label,
                  color: currentColor.resolvedValue,
                },
              ]
            : []),
          {
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.text.font-family"
              ](),
            value: currentFontFamily,
          },
          {
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.text.font-weight"
              ](),
            value: FontWeightMap[text.fontWeight],
          },
          {
            label:
              t["com.myoxus.settings.editorSettings.edgeless.text.alignment"](),
            value: currentAlignLabel,
          },
        ]}
      />
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.text.color"]()}
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
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-family"
        ]()}
        desc=""
      >
        <DropdownMenu
          items={fontFamilyItems}
          trigger={<DropdownTrigger>{currentFontFamily}</DropdownTrigger>}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-style"
        ]()}
        desc=""
      >
        <DropdownMenu
          items={fontStyleItems}
          trigger={<DropdownTrigger>{String(text.fontStyle)}</DropdownTrigger>}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-weight"
        ]()}
        desc=""
      >
        <DropdownMenu
          items={fontWeightItems}
          trigger={
            <DropdownTrigger>{FontWeightMap[text.fontWeight]}</DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.text.alignment"]()}
        desc=""
      >
        <EditorRadioGroup
          items={alignItems}
          value={text.textAlign}
          onChange={setTextAlign}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
