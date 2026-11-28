// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorSettingService } from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  DefaultTheme,
  NoteShadow,
  NoteShadowMap,
  StrokeStyle,
} from "@virgultum/editor/model";
import { useCallback, useMemo } from "react";

import {
  MenuItem,
  type RadioItem,
  SettingsRow,
  SettingsSection,
} from "../../../primitives";
import {
  DropdownMenu,
  DropdownTrigger,
  EditorRadioGroup,
  EditorSlider,
} from "../menu";
import { colorsEqual, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessStylePreview } from "./preview";

const CORNER_OPTIONS = [
  { name: "None", value: 0 },
  { name: "Small", value: 8 },
  { name: "Medium", value: 16 },
  { name: "Large", value: 24 },
  { name: "Huge", value: 32 },
] as const;

const THICKNESS_NODES = [2, 4, 6, 8, 10, 12];

export const NoteSettings = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const note = settings["myoxus:note"];
  const { borderRadius, borderSize, borderStyle, shadowType } =
    note.edgeless.style;

  const { palettes, getCurrentColor } = usePalettes(
    DefaultTheme.NoteBackgroundColorPalettes,
    DefaultTheme.noteBackgrounColor,
  );
  const currentColor = getCurrentColor(note.background);

  const borderStyleItems = useMemo<RadioItem[]>(
    () => [
      {
        value: StrokeStyle.Solid,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.note.border.solid"](),
      },
      {
        value: StrokeStyle.Dash,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.note.border.dash"](),
      },
      {
        value: StrokeStyle.None,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.note.border.none"](),
      },
    ],
    [t],
  );

  const updateNoteStyle = useCallback(
    (patch: Partial<typeof note.edgeless.style>) => {
      editorSetting.set("myoxus:note", {
        edgeless: { style: patch },
      });
    },
    [editorSetting],
  );

  const setBorderStyle = useCallback(
    (value: StrokeStyle) => updateNoteStyle({ borderStyle: value }),
    [updateNoteStyle],
  );

  const setBorderSize = useCallback(
    (value: number[]) => updateNoteStyle({ borderSize: value[0] }),
    [updateNoteStyle],
  );

  const backgroundItems = useMemo(
    () =>
      palettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => {
            editorSetting.set("myoxus:note", { background: value });
          }}
          selected={colorsEqual(note.background, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [editorSetting, note.background, palettes],
  );

  const cornerItems = useMemo(
    () =>
      CORNER_OPTIONS.map(({ name, value }) => (
        <MenuItem
          key={name}
          onSelect={() => updateNoteStyle({ borderRadius: value })}
          selected={borderRadius === value}
        >
          {name}
        </MenuItem>
      )),
    [borderRadius, updateNoteStyle],
  );

  const shadowItems = useMemo(
    () =>
      Object.entries(NoteShadow).map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => updateNoteStyle({ shadowType: value })}
          selected={shadowType === value}
        >
          {name}
        </MenuItem>
      )),
    [shadowType, updateNoteStyle],
  );

  const currentCornerName =
    CORNER_OPTIONS.find((item) => item.value === borderRadius)?.name ??
    String(borderRadius);
  const currentBorderLabel =
    borderStyleItems.find((item) => item.value === borderStyle)?.label ??
    borderStyle;
  const title = t["com.myoxus.settings.editorSettings.edgeless.note"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-note"
    >
      <EdgelessStylePreview
        sampleTitle={t[
          "com.myoxus.settings.editorSettings.edgeless.preview.note.headline"
        ]()}
        sampleBody={`${t["com.myoxus.settings.editorSettings.edgeless.preview.note.body1"]()} ${t["com.myoxus.settings.editorSettings.edgeless.preview.note.body2"]()}`}
        items={[
          ...(currentColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.note.background"
                    ](),
                  value: currentColor.label,
                  color: currentColor.resolvedValue,
                },
              ]
            : []),
          {
            label:
              t["com.myoxus.settings.editorSettings.edgeless.note.corners"](),
            value: currentCornerName,
          },
          {
            label:
              t["com.myoxus.settings.editorSettings.edgeless.note.shadow"](),
            value: NoteShadowMap[shadowType],
          },
          {
            label:
              t["com.myoxus.settings.editorSettings.edgeless.note.border"](),
            value:
              borderStyle === StrokeStyle.None ? (
                currentBorderLabel
              ) : (
                <>
                  {currentBorderLabel} ({borderSize}px)
                </>
              ),
          },
        ]}
      />
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.note.background"
        ]()}
        desc=""
      >
        {currentColor ? (
          <DropdownMenu
            items={backgroundItems}
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
        name={t["com.myoxus.settings.editorSettings.edgeless.note.corners"]()}
        desc=""
      >
        <DropdownMenu
          items={cornerItems}
          trigger={<DropdownTrigger>{currentCornerName}</DropdownTrigger>}
        />
      </SettingsRow>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.note.shadow"]()}
        desc=""
      >
        <DropdownMenu
          items={shadowItems}
          trigger={
            <DropdownTrigger>{NoteShadowMap[shadowType]}</DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.note.border"]()}
        desc=""
      >
        <EditorRadioGroup
          items={borderStyleItems}
          value={borderStyle}
          onChange={setBorderStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.note.border-thickness"
        ]()}
        desc=""
      >
        <EditorSlider
          value={[borderSize]}
          onValueChange={setBorderSize}
          min={2}
          max={12}
          step={2}
          nodes={THICKNESS_NODES}
          disabled={borderStyle === StrokeStyle.None}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
