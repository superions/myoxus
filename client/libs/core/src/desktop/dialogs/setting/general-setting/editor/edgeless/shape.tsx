import { TextUtils } from "@virgultum/editor/blocks/surface";
import {
  edgelessTextSizeOptions,
  EditorSettingService,
  formatEdgelessTextSizeLabel,
} from "@myoxus/core/modules/editor-setting";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData } from "@myoxus/infra";
import {
  EdgelessCRUDIdentifier,
  getSurfaceBlock,
} from "@virgultum/editor/blocks/surface";
import {
  DefaultTheme,
  FontStyle,
  FontWeightMap,
  getShapeName,
  type ShapeElementModel,
  type ShapeName,
  ShapeStyle,
  ShapeType,
  StrokeStyle,
  TextAlign,
} from "@virgultum/editor/model";
import type { EditorHost } from "@virgultum/editor/std";
import type { Store } from "@virgultum/editor/store";
import { isEqual } from "lodash-es";
import { useCallback, useMemo, useState } from "react";

import {
  EditorPreviewOverlay,
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
import { sortedFontWeightEntries, usePalettes } from "../utils";
import type { DocName } from "./docs";
import { Point } from "./point";
import { EdgelessSnapshot } from "./snapshot";

export const ShapeSettings = () => {
  const t = useI18n();
  const framework = useFramework();
  const { editorSetting } = framework.get(EditorSettingService);
  const settings = useLiveData(editorSetting.settings$);
  const {
    palettes: strokeColorPalettes,
    getCurrentColor: getCurrentStrokeColor,
  } = usePalettes(
    DefaultTheme.StrokeColorShortPalettes,
    DefaultTheme.shapeStrokeColor,
  );
  const { palettes: fillColorPalettes, getCurrentColor: getCurrentFillColor } =
    usePalettes(
      DefaultTheme.FillColorShortPalettes,
      DefaultTheme.shapeFillColor,
    );
  const { palettes: textColorPalettes, getCurrentColor: getCurrentTextColor } =
    usePalettes(
      DefaultTheme.ShapeTextColorShortPalettes,
      DefaultTheme.shapeTextColor,
      true,
    );

  const [currentShape, setCurrentShape] = useState<ShapeName>(ShapeType.Rect);

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

  const { shapeStyle } = settings[`shape:${currentShape}`];
  const setShapeStyle = useCallback(
    (value: ShapeStyle) => {
      editorSetting.set(`shape:${currentShape}`, {
        shapeStyle: value,
      });
    },
    [editorSetting, currentShape],
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

  const borderStyle = settings[`shape:${currentShape}`].strokeStyle;
  const setBorderStyle = useCallback(
    (value: StrokeStyle) => {
      editorSetting.set(`shape:${currentShape}`, {
        strokeStyle: value,
      });
    },
    [editorSetting, currentShape],
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

  const textAlignment = settings[`shape:${currentShape}`].textAlign;
  const setTextAlignment = useCallback(
    (value: TextAlign) => {
      editorSetting.set(`shape:${currentShape}`, {
        textAlign: value,
      });
    },
    [editorSetting, currentShape],
  );

  const shapes = useMemo<RadioItem[]>(
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

  const docs = useMemo<RadioItem[]>(
    () => [
      {
        value: "shape",
        label: t["com.myoxus.settings.editorSettings.edgeless.shape.list"](),
      },
      {
        value: "flow",
        label: t["com.myoxus.settings.editorSettings.edgeless.shape.flow"](),
      },
    ],
    [t],
  );
  const [currentDoc, setCurrentDoc] = useState<DocName>("shape");

  const fillColorItems = useMemo(() => {
    const { fillColor } = settings[`shape:${currentShape}`];
    return fillColorPalettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set(`shape:${currentShape}`, { fillColor: value });
      };
      const isSelected = isEqual(fillColor, value);
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
  }, [editorSetting, settings, currentShape, fillColorPalettes]);

  const strokeColorItems = useMemo(() => {
    const { strokeColor } = settings[`shape:${currentShape}`];
    return strokeColorPalettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set(`shape:${currentShape}`, { strokeColor: value });
      };
      const isSelected = isEqual(strokeColor, value);
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
  }, [editorSetting, settings, currentShape, strokeColorPalettes]);

  const borderThickness = settings[`shape:${currentShape}`].strokeWidth;
  const setBorderThickness = useCallback(
    (value: number[]) => {
      editorSetting.set(`shape:${currentShape}`, {
        strokeWidth: value[0],
      });
    },
    [editorSetting, currentShape],
  );

  const fontFamilyItems = useMemo(() => {
    const { fontFamily } = settings[`shape:${currentShape}`];
    return TextUtils.getFontFamilies().map((value) => {
      const name = value;
      const handler = () => {
        editorSetting.set(`shape:${currentShape}`, { fontFamily: value });
      };
      const isSelected = TextUtils.getFontFamilyName(fontFamily) === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings, currentShape]);

  const fontStyleItems = useMemo(() => {
    const { fontStyle } = settings[`shape:${currentShape}`];
    return Object.entries(FontStyle).map(([name, value]) => {
      const handler = () => {
        editorSetting.set(`shape:${currentShape}`, { fontStyle: value });
      };
      const isSelected = fontStyle === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings, currentShape]);

  const fontWeightItems = useMemo(() => {
    const { fontWeight } = settings[`shape:${currentShape}`];
    return sortedFontWeightEntries.map(([name, value]) => {
      const handler = () => {
        editorSetting.set(`shape:${currentShape}`, { fontWeight: value });
      };
      const isSelected = fontWeight === value;
      return (
        <MenuItem key={name} onSelect={handler} selected={isSelected}>
          {name}
        </MenuItem>
      );
    });
  }, [editorSetting, settings, currentShape]);

  const fontSizeItems = useMemo(() => {
    const { fontSize } = settings[`shape:${currentShape}`];
    return edgelessTextSizeOptions.map((value) => {
      const handler = () => {
        editorSetting.set(`shape:${currentShape}`, { fontSize: value });
      };
      const label = formatEdgelessTextSizeLabel(value);
      const isSelected = fontSize === value;
      return (
        <MenuItem key={value} onSelect={handler} selected={isSelected}>
          {label}
        </MenuItem>
      );
    });
  }, [editorSetting, settings, currentShape]);

  const textColorItems = useMemo(() => {
    const { color } = settings[`shape:${currentShape}`];
    return textColorPalettes.map(({ key, label, value, resolvedValue }) => {
      const handler = () => {
        editorSetting.set(`shape:${currentShape}`, { color: value });
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
  }, [editorSetting, settings, currentShape, textColorPalettes]);

  const getElements = useCallback(
    (doc: Store) => {
      const surface = getSurfaceBlock(doc);
      if (!surface) return [];
      return surface.getElementsByType("shape").filter((node) => {
        const shape = node as ShapeElementModel;
        const { shapeType, radius } = shape;
        const shapeName = getShapeName(shapeType, radius);
        return shapeName === currentShape;
      });
    },
    [currentShape],
  );

  const firstUpdate = useCallback(
    (doc: Store, editorHost: EditorHost) => {
      const surface = getSurfaceBlock(doc);
      if (!surface) return;
      const crud = editorHost.std.get(EdgelessCRUDIdentifier);
      doc.readonly = false;
      surface.getElementsByType("shape").forEach((node) => {
        const shape = node as ShapeElementModel;
        const { shapeType, radius } = shape;
        const shapeName = getShapeName(shapeType, radius);
        const props = editorSetting.get(`shape:${shapeName}`);
        crud.updateElement(shape.id, props);
      });
      doc.readonly = true;
    },
    [editorSetting],
  );

  const fillColor = useMemo(() => {
    const color = settings[`shape:${currentShape}`].fillColor;
    return getCurrentFillColor(color);
  }, [currentShape, getCurrentFillColor, settings]);

  const strokeColor = useMemo(() => {
    const color = settings[`shape:${currentShape}`].strokeColor;
    return getCurrentStrokeColor(color);
  }, [currentShape, getCurrentStrokeColor, settings]);

  const textColor = useMemo(() => {
    const color = settings[`shape:${currentShape}`].color;
    return getCurrentTextColor(color);
  }, [currentShape, getCurrentTextColor, settings]);

  const title = t["com.myoxus.settings.editorSettings.edgeless.shape"]();

  return (
    <SettingsSection
      title={title}
      testId="editor-settings-section-edgeless-shape"
    >
      <EdgelessSnapshot
        key={currentDoc}
        title={title}
        docName={currentDoc}
        keyName={`shape:${currentShape}`}
        previewSize={currentDoc === "flow" ? "flow" : "default"}
        getElements={getElements}
        firstUpdate={firstUpdate}
      >
        <EditorPreviewOverlay>
          <RadioGroup
            value={currentDoc}
            items={docs}
            onChange={setCurrentDoc}
            block
          />
        </EditorPreviewOverlay>
      </EdgelessSnapshot>

      <SettingsInlineControl wrap>
        <RadioGroup
          value={currentShape}
          items={shapes}
          onChange={setCurrentShape}
          block
        />
      </SettingsInlineControl>
      <SettingsRow
        name={t["com.myoxus.settings.editorSettings.edgeless.style"]()}
        desc={""}
      >
        <EditorRadioGroup
          items={shapeStyleItems}
          value={shapeStyle}
          onChange={setShapeStyle}
        />
      </SettingsRow>
      <SettingsRow
        name={t[
          "com.myoxus.settings.editorSettings.edgeless.shape.fill-color"
        ]()}
        desc={""}
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
        desc={""}
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
          "com.myoxus.settings.editorSettings.edgeless.shape.border-thickness"
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
          disabled={borderStyle === StrokeStyle.None}
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
                settings[`shape:${currentShape}`].fontFamily,
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
                settings[`shape:${currentShape}`].fontSize,
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
              {settings[`shape:${currentShape}`].fontStyle}
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
              {FontWeightMap[settings[`shape:${currentShape}`].fontWeight]}
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
