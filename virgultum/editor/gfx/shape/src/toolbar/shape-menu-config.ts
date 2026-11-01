import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  editorMessage,
  type EditorI18nMessage,
} from "@virgultum/shared/services";
import {
  DiamondIcon,
  EllipseIcon,
  RoundedRectangleIcon,
  SquareIcon,
  TriangleIcon,
} from "@myoxus/icons/lit";
import type { ShapeToolOption } from "@virgultum/gfx-shape";
import { ShapeType } from "@virgultum/model";
import type { TemplateResult } from "lit";

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
  generalIcon: TemplateResult<1>;
  scribbledIcon: TemplateResult<1>;
  tooltip: EditorI18nMessage;
  disabled: boolean;
};

export const ShapeComponentConfig: Config[] = [
  {
    name: ShapeType.Rect,
    iconName: "SquareIcon",
    generalIcon: SquareIcon(),
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
    generalIcon: EllipseIcon(),
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
    generalIcon: DiamondIcon(),
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
    generalIcon: TriangleIcon(),
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
    generalIcon: RoundedRectangleIcon(),
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
