import { TextUtils } from "@virgultum/editor/blocks/surface";
import {
  edgelessTextSizeOptions,
  EditorSettingService,
  formatEdgelessTextSizeLabel,
} from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData } from "@myoxus/infra";
import { getSurfaceBlock } from "@virgultum/editor/blocks/surface";
import {
  ConnectorMode,
  DefaultTheme,
  FontStyle,
  FontWeightMap,
  PointStyle,
  StrokeStyle,
  TextAlign,
} from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";
import { isEqual } from "lodash-es";
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
import { sortedFontWeightEntries, usePalettes } from "../utils";
import { Point } from "./point";
import { EdgelessSnapshot } from "./snapshot";

enum ConnecterStyle {
  General = "general",
  Scribbled = "scribbled",
}

export const ConnectorSettings = () => {
  const t = useI18n();
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const {
    palettes: StrokeColorShortPalettes,
    getCurrentColor: getCurrentStrokeColor,
  } = usePalettes(
    DefaultTheme.StrokeColorShortPalettes,
    DefaultTheme.connectorColor,
  );
  const { palettes: textColorPalettes, getCurrentColor: getCurrentTextColor } =
    usePalettes(DefaultTheme.StrokeColorShortPalettes, DefaultTheme.black);

  const connecterStyleItems = useMemo<RadioItem[]>(
    () => [
      {
        value: ConnecterStyle.General,
        label: t["com.myoxus.settings.editorSettings.edgeless.style.general"](),
      },
      {
        value: ConnecterStyle.Scribbled,
        label:
          t["com.myoxus.settings.editorSettings.edgeless.style.scribbled"](),
      },
    ],
    [t],
  );
  const connecterStyle: ConnecterStyle = settings.connector.rough
    ? ConnecterStyle.Scribbled
    : ConnecterStyle.General;
  const setConnecterStyle = useCallback(
    (value: ConnecterStyle) => {
      const isRough = value === ConnecterStyle.Scribbled;
      editorSetting.set("connector", {
        rough: isRough,
      });
    },
    [editorSetting],
  );

  const connectorShapeItems = useMemo<RadioItem[]>(
    () => [
      {
        value: ConnectorMode.Orthogonal as any,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape.elbowed"
          ](),
      },
      {
        value: ConnectorMode.Curve as any,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape.curve"
          ](),
      },
      {
        value: ConnectorMode.Straight as any,
        label:
          t[
            "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape.straight"
          ](),
      },
    ],
    [t],
  );
  const connectorShape: ConnectorMode = settings.connector.mode;
  const setConnectorShape = useCallback(
    (value: ConnectorMode) => {
      editorSetting.set("connector", {
        mode: value,
      });
    },
    [editorSetting],
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
  const borderStyle: StrokeStyle = settings.connector.strokeStyle;
  const setBorderStyle = useCallback(
    (value: StrokeStyle) => {
      editorSetting.set("connector", {
        strokeStyle: value,
      });
    },
    [editorSetting],
  );

  const borderThickness = settings.connector.strokeWidth;
  const setBorderThickness = useCallback(
    (value: number[]) => {
      editorSetting.set("connector", {
        strokeWidth: value[0],
      });
    },
    [editorSetting],
  );

  const currentColor = useMemo(() => {
    const color = settings.connector.stroke;
    return getCurrentStrokeColor(color);
  }, [getCurrentStrokeColor, settings.connector.stroke]);

  const colorItems = useMemo(() => {
    const { stroke } = settings.connector;
    return StrokeColorShortPalettes.map(
      ({ key, label, value, resolvedValue }) => {
        const handler = () => {
          editorSetting.set("connector", { stroke: value });
        };
        const isSelected = isEqual(stroke, value);
        return (
          <MenuItem
            key={key}
            onSelect={handler}
            selected={isSelected}
            prefix={<Point color={resolvedValue} />}
          >
            {label}
          </MenuItem>
        );
      },
    );
  }, [editorSetting, settings, StrokeColorShortPalettes]);

  const startEndPointItems = useMemo(() => {
    const { frontEndpointStyle } = settings.connector;
    return Object.entries(PointStyle).map(([name, value]) => {
      const handler = () => {
        editorSetting.set("connector", { frontEndpointStyle: value });
      };
      const isSelected = frontEndpointStyle === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const endEndPointItems = useMemo(() => {
    const { rearEndpointStyle } = settings.connector;
    return Object.entries(PointStyle).map(([name, value]) => {
      const handler = () => {
        editorSetting.set("connector", { rearEndpointStyle: value });
      };
      const isSelected = rearEndpointStyle === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

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

  const textAlignment = settings.connector.labelStyle.textAlign;
  const setTextAlignment = useCallback(
    (value: TextAlign) => {
      editorSetting.set("connector", {
        labelStyle: {
          textAlign: value,
        },
      });
    },
    [editorSetting],
  );

  const fontFamilyItems = useMemo(() => {
    const { fontFamily } = settings.connector.labelStyle;
    return TextUtils.getFontFamilies().map((value) => {
      const name = value;
      const handler = () => {
        editorSetting.set("connector", {
          labelStyle: {
            fontFamily: value,
          },
        });
      };
      const isSelected = TextUtils.getFontFamilyName(fontFamily) === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const fontStyleItems = useMemo(() => {
    const { fontStyle } = settings.connector.labelStyle;
    return Object.entries(FontStyle).map(([name, value]) => {
      const handler = () => {
        editorSetting.set("connector", {
          labelStyle: {
            fontStyle: value,
          },
        });
      };
      const isSelected = fontStyle === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const fontWeightItems = useMemo(() => {
    const { fontWeight } = settings.connector.labelStyle;
    return sortedFontWeightEntries.map(([name, value]) => {
      const handler = () => {
        editorSetting.set("connector", {
          labelStyle: {
            fontWeight: value,
          },
        });
      };
      const isSelected = fontWeight === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const fontSizeItems = useMemo(() => {
    const { fontSize } = settings.connector.labelStyle;
    return edgelessTextSizeOptions.map((value) => {
      const handler = () => {
        editorSetting.set("connector", {
          labelStyle: {
            fontSize: value,
          },
        });
      };
      const label = formatEdgelessTextSizeLabel(value);
      const isSelected = fontSize === value;
      return (
        <MenuItem key={value} onSelect={handler} selected={isSelected}>
          {label}
        </MenuItem>
      );
    });
  }, [editorSetting, settings]);

  const textColorItems = useMemo(() => {
    const { color } = settings.connector.labelStyle;
    return textColorPalettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set("connector", {
          labelStyle: {
            color: value,
          },
        });
      };
      const isSelected = isEqual(color, value);
      return (
        <MenuItem
          key={key}
          onSelect={handler}
          selected={isSelected}
          prefix={<Point color={resolvedValue} />}
        >
          {label}
        </MenuItem>
      );
    });
  }, [editorSetting, settings, textColorPalettes]);

  const textColor = useMemo(() => {
    const { color } = settings.connector.labelStyle;
    return getCurrentTextColor(color);
  }, [getCurrentTextColor, settings]);

  const getElements = useCallback((doc: Store) => {
    const surface = getSurfaceBlock(doc);
    return surface?.getElementsByType("connector") || [];
  }, []);
  const title = t["com.myoxus.settings.editorSettings.edgeless.connecter"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-connector"
    >
      <EdgelessSnapshot
        title={title}
        docName="connector"
        keyName="connector"
        getElements={getElements}
      />
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.color"
        ]()}
        desc={""}
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
        desc={""}
      >
        <EditorRadioGroup
          items={connecterStyleItems}
          value={connecterStyle}
          onChange={setConnecterStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.connector-shape"
        ]()}
        desc={""}
      >
        <EditorRadioGroup
          items={connectorShapeItems}
          value={connectorShape}
          onChange={setConnectorShape}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.border-style"
        ]()}
        desc={""}
      >
        <EditorRadioGroup
          items={borderStyleItems}
          value={borderStyle}
          onChange={setBorderStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.border-thickness"
        ]()}
        desc={""}
      >
        <EditorSlider
          value={[borderThickness]}
          onValueChange={setBorderThickness}
          min={2}
          max={12}
          step={2}
          nodes={[2, 4, 6, 8, 10, 12]}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.start-endpoint"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={startEndPointItems}
          trigger={
            <DropdownTrigger>
              {String(settings.connector.frontEndpointStyle)}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.connecter.end-endpoint"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={endEndPointItems}
          trigger={
            <DropdownTrigger>
              {String(settings.connector.rearEndpointStyle)}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.text-color"
        ]()}
        desc={""}
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
        desc={""}
      >
        <DropdownMenu
          items={fontFamilyItems}
          trigger={
            <DropdownTrigger>
              {TextUtils.getFontFamilyName(
                settings.connector.labelStyle.fontFamily,
              )}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.font-size"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={fontSizeItems}
          trigger={
            <DropdownTrigger>
              {formatEdgelessTextSizeLabel(
                settings.connector.labelStyle.fontSize,
              )}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-style"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={fontStyleItems}
          trigger={
            <DropdownTrigger>
              {settings.connector.labelStyle.fontStyle}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.text.font-weight"
        ]()}
        desc={""}
      >
        <DropdownMenu
          items={fontWeightItems}
          trigger={
            <DropdownTrigger>
              {FontWeightMap[settings.connector.labelStyle.fontWeight]}
            </DropdownTrigger>
          }
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.text-alignment"
        ]()}
        desc={""}
      >
        <EditorRadioGroup
          items={alignItems}
          value={textAlignment}
          onChange={setTextAlignment}
        />
      </SettingsRow>
    </SettingsSection>
  );
};
