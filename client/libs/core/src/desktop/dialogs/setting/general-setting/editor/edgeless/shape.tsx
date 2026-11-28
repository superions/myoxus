// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  edgelessTextSizeOptions,
  EditorSettingService,
  formatEdgelessTextSizeLabel,
} from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { TextUtils } from "@virgultum/editor/blocks/surface";
import {
  DefaultTheme,
  FontStyle,
  FontWeightMap,
  type ShapeName,
  ShapeStyle,
  ShapeType,
  StrokeStyle,
  TextAlign,
} from "@virgultum/editor/model";
import { useCallback, useMemo, useState } from "react";

import {
  MenuItem,
  RadioGroup,
  type RadioItem,
  SettingsInlineControl,
  SettingsRow,
  SettingsSection,
} from "../../../primitives";
import {
  DropdownMenu,
  DropdownTrigger,
  EditorRadioGroup,
  EditorSlider,
} from "../menu";
import { colorsEqual, sortedFontWeightEntries, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessStylePreview } from "./preview";

const THICKNESS_NODES = [2, 4, 6, 8, 10, 12];

export const ShapeSettings = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const [currentShape, setCurrentShape] = useState<ShapeName>(ShapeType.Rect);

  const shapeKey = `shape:${currentShape}` as const;
  const shape = settings[shapeKey];

  const { palettes: strokePalettes, getCurrentColor: getCurrentStrokeColor } =
    usePalettes(
      DefaultTheme.StrokeColorShortPalettes,
      DefaultTheme.shapeStrokeColor,
    );
  const { palettes: fillPalettes, getCurrentColor: getCurrentFillColor } =
    usePalettes(
      DefaultTheme.FillColorShortPalettes,
      DefaultTheme.shapeFillColor,
    );
  const { palettes: textPalettes, getCurrentColor: getCurrentTextColor } =
    usePalettes(
      DefaultTheme.ShapeTextColorShortPalettes,
      DefaultTheme.shapeTextColor,
      true,
    );

  const fillColor = getCurrentFillColor(shape.fillColor);
  const strokeColor = getCurrentStrokeColor(shape.strokeColor);
  const textColor = getCurrentTextColor(shape.color);

  const updateShape = useCallback(
    (patch: Partial<typeof shape>) => {
      editorSetting.set(shapeKey, patch);
    },
    [editorSetting, shapeKey],
  );

  const shapeOptions = useMemo<RadioItem[]>(
    () => [
      {
        value: ShapeType.Rect,
        label: t["com.myoxus.settings.editorSettings.edgeless.shape.square"](),
      },
      {
        value: ShapeType.Ellipse,
        label: t["com.myoxus.settings.editorSettings.edgeless.shape.ellipse"](),
      },
      {
        value: ShapeType.Diamond,
        label: t["com.myoxus.settings.editorSettings.edgeless.shape.diamond"](),
      },
      {
        value: ShapeType.Triangle,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.shape.triangle"](),
      },
      {
        value: "roundedRect",
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.shape.rounded-rectangle"
          ](),
      },
    ],
    [t],
  );

  const shapeStyleItems = useMemo<RadioItem[]>(
    () => [
      {
        value: ShapeStyle.General,
        label: t["com.myoxus.settings.editorSettings.edgeless.style.general"](),
      },
      {
        value: ShapeStyle.Scribbled,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.style.scribbled"](),
      },
    ],
    [t],
  );

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

  const setShapeStyle = useCallback(
    (value: ShapeStyle) => updateShape({ shapeStyle: value }),
    [updateShape],
  );

  const setBorderStyle = useCallback(
    (value: StrokeStyle) => updateShape({ strokeStyle: value }),
    [updateShape],
  );

  const setBorderThickness = useCallback(
    (value: number[]) => updateShape({ strokeWidth: value[0] }),
    [updateShape],
  );

  const setTextAlignment = useCallback(
    (value: TextAlign) => updateShape({ textAlign: value }),
    [updateShape],
  );

  const fillColorItems = useMemo(
    () =>
      fillPalettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => updateShape({ fillColor: value })}
          selected={colorsEqual(shape.fillColor, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [fillPalettes, shape.fillColor, updateShape],
  );

  const strokeColorItems = useMemo(
    () =>
      strokePalettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => updateShape({ strokeColor: value })}
          selected={colorsEqual(shape.strokeColor, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [shape.strokeColor, strokePalettes, updateShape],
  );

  const textColorItems = useMemo(
    () =>
      textPalettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => updateShape({ color: value })}
          selected={colorsEqual(shape.color, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [shape.color, textPalettes, updateShape],
  );

  const currentFontFamily = TextUtils.getFontFamilyName(shape.fontFamily);
  const fontFamilyItems = useMemo(
    () =>
      TextUtils.getFontFamilies().map((family) => (
        <MenuItem
          key={family}
          onSelect={() => updateShape({ fontFamily: family })}
          selected={currentFontFamily === family}
        >
          {family}
        </MenuItem>
      )),
    [currentFontFamily, updateShape],
  );

  const fontSizeItems = useMemo(
    () =>
      edgelessTextSizeOptions.map((size) => (
        <MenuItem
          key={size}
          onSelect={() => updateShape({ fontSize: size })}
          selected={shape.fontSize === size}
        >
          {formatEdgelessTextSizeLabel(size)}
        </MenuItem>
      )),
    [shape.fontSize, updateShape],
  );

  const fontStyleItems = useMemo(
    () =>
      Object.entries(FontStyle).map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => updateShape({ fontStyle: value })}
          selected={shape.fontStyle === value}
        >
          {name}
        </MenuItem>
      )),
    [shape.fontStyle, updateShape],
  );

  const fontWeightItems = useMemo(
    () =>
      sortedFontWeightEntries.map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => updateShape({ fontWeight: value })}
          selected={shape.fontWeight === value}
        >
          {name}
        </MenuItem>
      )),
    [shape.fontWeight, updateShape],
  );

  const currentShapeLabel =
    shapeOptions.find((item) => item.value === currentShape)?.label ??
    currentShape;
  const currentStyleLabel =
    shapeStyleItems.find((item) => item.value === shape.shapeStyle)?.label ??
    shape.shapeStyle;
  const title = t["com.myoxus.settings.editorSettings.edgeless.shape"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-shape"
    >
      <EdgelessStylePreview
        sampleTitle={
          <>
            {currentShapeLabel} · {currentStyleLabel}
          </>
        }
        items={[
          ...(fillColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.shape.fill-color"
                    ](),
                  value: fillColor.label,
                  color: fillColor.resolvedValue,
                },
              ]
            : []),
          ...(strokeColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.shape.border-color"
                    ](),
                  value: strokeColor.label,
                  color: strokeColor.resolvedValue,
                },
              ]
            : []),
          ...(textColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.shape.text-color"
                    ](),
                  value: textColor.label,
                  color: textColor.resolvedValue,
                },
              ]
            : []),
          {
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.shape.font-size"
              ](),
            value: formatEdgelessTextSizeLabel(shape.fontSize),
          },
        ]}
      />
      <SettingsInlineControl wrap>
        <RadioGroup
          value={currentShape}
          items={shapeOptions}
          onChange={setCurrentShape}
          block
        />
      </SettingsInlineControl>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.style"]()}
        desc=""
      >
        <EditorRadioGroup
          items={shapeStyleItems}
          value={shape.shapeStyle}
          onChange={setShapeStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.fill-color"
        ]()}
        desc=""
      >
        {fillColor ? (
          <DropdownMenu
            items={fillColorItems}
            trigger={
              <DropdownTrigger
                prefix={<Point color={fillColor.resolvedValue} />}
              >
                {fillColor.label}
              </DropdownTrigger>
            }
          />
        ) : null}
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.border-color"
        ]()}
        desc=""
      >
        {strokeColor ? (
          <DropdownMenu
            items={strokeColorItems}
            trigger={
              <DropdownTrigger
                prefix={<Point color={strokeColor.resolvedValue} />}
              >
                {strokeColor.label}
              </DropdownTrigger>
            }
          />
        ) : null}
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.border-style"
        ]()}
        desc=""
      >
        <EditorRadioGroup
          items={borderStyleItems}
          value={shape.strokeStyle}
          onChange={setBorderStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.border-thickness"
        ]()}
        desc=""
      >
        <EditorSlider
          value={[shape.strokeWidth]}
          onValueChange={setBorderThickness}
          min={2}
          max={12}
          step={2}
          nodes={THICKNESS_NODES}
          disabled={shape.strokeStyle === StrokeStyle.None}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.text-color"
        ]()}
        desc=""
      >
        {textColor ? (
          <DropdownMenu
            items={textColorItems}
            trigger={
              <DropdownTrigger
                prefix={<Point color={textColor.resolvedValue} />}
              >
                {textColor.label}
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
          "com.myoxus.settings.editorSettings.edgeless.shape.font-size"
        ]()}
        desc=""
      >
        <DropdownMenu
          items={fontSizeItems}
          trigger={
            <DropdownTrigger>
              {formatEdgelessTextSizeLabel(shape.fontSize)}
            </DropdownTrigger>
          }
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
          trigger={<DropdownTrigger>{shape.fontStyle}</DropdownTrigger>}
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
            <DropdownTrigger>{FontWeightMap[shape.fontWeight]}</DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.text-alignment"
        ]()}
        desc=""
      >
        <EditorRadioGroup
          items={alignItems}
          value={shape.textAlign}
          onChange={setTextAlignment}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
