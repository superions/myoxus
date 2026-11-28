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
  ConnectorMode,
  DefaultTheme,
  FontStyle,
  FontWeightMap,
  PointStyle,
  StrokeStyle,
  TextAlign,
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
import { colorsEqual, sortedFontWeightEntries, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessStylePreview } from "./preview";

type ConnectorStyleKind = "general" | "scribbled";

const THICKNESS_NODES = [2, 4, 6, 8, 10, 12];

export const ConnectorSettings = () => {
  const t = useI18n();
  const { editorSetting } = useService(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const connector = settings.connector;

  const { palettes: strokePalettes, getCurrentColor: getCurrentStrokeColor } =
    usePalettes(
      DefaultTheme.StrokeColorShortPalettes,
      DefaultTheme.connectorColor,
    );
  const { palettes: textPalettes, getCurrentColor: getCurrentTextColor } =
    usePalettes(DefaultTheme.StrokeColorShortPalettes, DefaultTheme.black);

  const currentColor = getCurrentStrokeColor(connector.stroke);
  const textColor = getCurrentTextColor(connector.labelStyle.color);

  const updateLabelStyle = useCallback(
    (patch: Partial<typeof connector.labelStyle>) => {
      editorSetting.set("connector", { labelStyle: patch });
    },
    [editorSetting],
  );

  const styleItems = useMemo<RadioItem[]>(
    () => [
      {
        value: "general",
        label: t["com.myoxus.settings.editorSettings.edgeless.style.general"](),
      },
      {
        value: "scribbled",
        label:
          t["com.myoxus.settings.editorSettings.edgeless.style.scribbled"](),
      },
    ],
    [t],
  );

  const connectorShapeItems = useMemo<RadioItem[]>(
    () => [
      {
        value: ConnectorMode.Orthogonal as unknown as string,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape.elbowed"
          ](),
      },
      {
        value: ConnectorMode.Curve as unknown as string,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape.curve"
          ](),
      },
      {
        value: ConnectorMode.Straight as unknown as string,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape.straight"
          ](),
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

  const connectorStyle: ConnectorStyleKind = connector.rough
    ? "scribbled"
    : "general";

  const setConnectorStyle = useCallback(
    (value: ConnectorStyleKind) => {
      editorSetting.set("connector", { rough: value === "scribbled" });
    },
    [editorSetting],
  );

  const setConnectorShape = useCallback(
    (value: ConnectorMode) => {
      editorSetting.set("connector", { mode: value });
    },
    [editorSetting],
  );

  const setBorderStyle = useCallback(
    (value: StrokeStyle) => {
      editorSetting.set("connector", { strokeStyle: value });
    },
    [editorSetting],
  );

  const setBorderThickness = useCallback(
    (value: number[]) => {
      editorSetting.set("connector", { strokeWidth: value[0] });
    },
    [editorSetting],
  );

  const setTextAlignment = useCallback(
    (value: TextAlign) => updateLabelStyle({ textAlign: value }),
    [updateLabelStyle],
  );

  const colorItems = useMemo(
    () =>
      strokePalettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => {
            editorSetting.set("connector", { stroke: value });
          }}
          selected={colorsEqual(connector.stroke, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [connector.stroke, editorSetting, strokePalettes],
  );

  const startEndpointItems = useMemo(
    () =>
      Object.entries(PointStyle).map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => {
            editorSetting.set("connector", { frontEndpointStyle: value });
          }}
          selected={connector.frontEndpointStyle === value}
        >
          {name}
        </MenuItem>
      )),
    [connector.frontEndpointStyle, editorSetting],
  );

  const endEndpointItems = useMemo(
    () =>
      Object.entries(PointStyle).map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => {
            editorSetting.set("connector", { rearEndpointStyle: value });
          }}
          selected={connector.rearEndpointStyle === value}
        >
          {name}
        </MenuItem>
      )),
    [connector.rearEndpointStyle, editorSetting],
  );

  const currentFontFamily = TextUtils.getFontFamilyName(
    connector.labelStyle.fontFamily,
  );
  const fontFamilyItems = useMemo(
    () =>
      TextUtils.getFontFamilies().map((family) => (
        <MenuItem
          key={family}
          onSelect={() => updateLabelStyle({ fontFamily: family })}
          selected={currentFontFamily === family}
        >
          {family}
        </MenuItem>
      )),
    [currentFontFamily, updateLabelStyle],
  );

  const fontSizeItems = useMemo(
    () =>
      edgelessTextSizeOptions.map((size) => (
        <MenuItem
          key={size}
          onSelect={() => updateLabelStyle({ fontSize: size })}
          selected={connector.labelStyle.fontSize === size}
        >
          {formatEdgelessTextSizeLabel(size)}
        </MenuItem>
      )),
    [connector.labelStyle.fontSize, updateLabelStyle],
  );

  const fontStyleItems = useMemo(
    () =>
      Object.entries(FontStyle).map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => updateLabelStyle({ fontStyle: value })}
          selected={connector.labelStyle.fontStyle === value}
        >
          {name}
        </MenuItem>
      )),
    [connector.labelStyle.fontStyle, updateLabelStyle],
  );

  const fontWeightItems = useMemo(
    () =>
      sortedFontWeightEntries.map(([name, value]) => (
        <MenuItem
          key={name}
          onSelect={() => updateLabelStyle({ fontWeight: value })}
          selected={connector.labelStyle.fontWeight === value}
        >
          {name}
        </MenuItem>
      )),
    [connector.labelStyle.fontWeight, updateLabelStyle],
  );

  const textColorItems = useMemo(
    () =>
      textPalettes.map(({ key, label, value, resolvedValue }) => (
        <MenuItem
          key={key}
          onSelect={() => updateLabelStyle({ color: value })}
          selected={colorsEqual(connector.labelStyle.color, value)}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      )),
    [connector.labelStyle.color, textPalettes, updateLabelStyle],
  );

  const currentShapeLabel =
    connectorShapeItems.find(
      (item) => item.value === (connector.mode as unknown as string),
    )?.label ?? String(connector.mode);
  const currentBorderLabel =
    borderStyleItems.find((item) => item.value === connector.strokeStyle)
      ?.label ?? connector.strokeStyle;
  const title = t["com.myoxus.settings.editorSettings.edgeless.connecter"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-connector"
    >
      <EdgelessStylePreview
        sampleTitle={t[
          "com.myoxus.settings.editorSettings.edgeless.preview.connector.label"
        ]()}
        items={[
          ...(currentColor
            ? [
                {
                  label:
                    t[
                      "com.myoxus.settings.editorSettings.edgeless.connecter.color"
                    ](),
                  value: currentColor.label,
                  color: currentColor.resolvedValue,
                },
              ]
            : []),
          {
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape"
              ](),
            value: currentShapeLabel,
          },
          {
            label:
              t[
                "com.myoxus.settings.editorSettings.edgeless.connecter.border-style"
              ](),
            value: (
              <>
                {currentBorderLabel} ({connector.strokeWidth}px)
              </>
            ),
          },
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
        ]}
      />
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.color"
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
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.style"]()}
        desc=""
      >
        <EditorRadioGroup
          items={styleItems}
          value={connectorStyle}
          onChange={setConnectorStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape"
        ]()}
        desc=""
      >
        <EditorRadioGroup
          items={connectorShapeItems}
          value={connector.mode}
          onChange={setConnectorShape}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.border-style"
        ]()}
        desc=""
      >
        <EditorRadioGroup
          items={borderStyleItems}
          value={connector.strokeStyle}
          onChange={setBorderStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.border-thickness"
        ]()}
        desc=""
      >
        <EditorSlider
          value={[connector.strokeWidth]}
          onValueChange={setBorderThickness}
          min={2}
          max={12}
          step={2}
          nodes={THICKNESS_NODES}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.start-endpoint"
        ]()}
        desc=""
      >
        <DropdownMenu
          items={startEndpointItems}
          trigger={
            <DropdownTrigger>
              {String(connector.frontEndpointStyle)}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.end-endpoint"
        ]()}
        desc=""
      >
        <DropdownMenu
          items={endEndpointItems}
          trigger={
            <DropdownTrigger>
              {String(connector.rearEndpointStyle)}
            </DropdownTrigger>
          }
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
              {formatEdgelessTextSizeLabel(connector.labelStyle.fontSize)}
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
          trigger={
            <DropdownTrigger>{connector.labelStyle.fontStyle}</DropdownTrigger>
          }
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
            <DropdownTrigger>
              {FontWeightMap[connector.labelStyle.fontWeight]}
            </DropdownTrigger>
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
          value={connector.labelStyle.textAlign}
          onChange={setTextAlignment}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
