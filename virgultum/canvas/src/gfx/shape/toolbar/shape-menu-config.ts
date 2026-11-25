import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  editorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import type { ShapeToolOption } from "../index";
import { ShapeType } from "@virgultum/core/models";

import {
  ScribbledDiamondIcon,
  ScribbledEllipseIcon,
  ScribbledRoundedRectangleIcon,
  ScribbledSquareIcon,
  ScribbledTriangleIcon,
} from "./icons";

type Config = {
  iconName: MyoxusIconExportName;
  name: ShapeToolOption["shapeName"];
  scribbledIcon: string;
  tooltip: EditorI18nMessage;
  disabled: boolean;
};

export const ShapeComponentConfig: Config[] = [
  {
    name: ShapeType.Rect,
    iconName: "SquareIcon",
    scribbledIcon: ScribbledSquareIcon,
    tooltip: editorMessage(
      "com.myoxus.settings.editorSettings.edgeless.shape.square",
      "Square",
    ),
    disabled: false,
  },
  {
    name: ShapeType.Ellipse,
    iconName: "EllipseIcon",
    scribbledIcon: ScribbledEllipseIcon,
    tooltip: editorMessage(
      "com.myoxus.settings.editorSettings.edgeless.shape.ellipse",
      "Ellipse",
    ),
    disabled: false,
  },
  {
    name: ShapeType.Diamond,
    iconName: "DiamondIcon",
    scribbledIcon: ScribbledDiamondIcon,
    tooltip: editorMessage(
      "com.myoxus.settings.editorSettings.edgeless.shape.diamond",
      "Diamond",
    ),
    disabled: false,
  },
  {
    name: ShapeType.Triangle,
    iconName: "TriangleIcon",
    scribbledIcon: ScribbledTriangleIcon,
    tooltip: editorMessage(
      "com.myoxus.settings.editorSettings.edgeless.shape.triangle",
      "Triangle",
    ),
    disabled: false,
  },
  {
    name: "roundedRect",
    iconName: "RoundedRectangleIcon",
    scribbledIcon: ScribbledRoundedRectangleIcon,
    tooltip: editorMessage(
      "com.myoxus.editor.shape.rounded-rectangle",
      "Rounded rectangle",
    ),
    disabled: false,
  },
];

export const ShapeComponentConfigMap = ShapeComponentConfig.reduce(
  (acc, config) => {
    acc[config.name] = config;
    return acc;
  },
  {} as Record<Config["name"], Config>,
);
