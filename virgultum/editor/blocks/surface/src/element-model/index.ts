import {
  BrushElementModel,
  ConnectorElementModel,
  GroupElementModel,
  HighlighterElementModel,
  ShapeElementModel,
  TextElementModel,
} from "@virgultum/model";

import { SurfaceElementModel } from "./base.js";

export const elementsCtorMap = {
  group: GroupElementModel,
  connector: ConnectorElementModel,
  shape: ShapeElementModel,
  brush: BrushElementModel,
  text: TextElementModel,
  highlighter: HighlighterElementModel,
};

export {
  BrushElementModel,
  ConnectorElementModel,
  GroupElementModel,
  HighlighterElementModel,
  ShapeElementModel,
  SurfaceElementModel,
  TextElementModel,
};

export enum CanvasElementType {
  BRUSH = "brush",
  CONNECTOR = "connector",
  GROUP = "group",
  SHAPE = "shape",
  TEXT = "text",
  HIGHLIGHTER = "highlighter",
}

export type ElementModelMap = {
  ["shape"]: ShapeElementModel;
  ["brush"]: BrushElementModel;
  ["connector"]: ConnectorElementModel;
  ["text"]: TextElementModel;
  ["group"]: GroupElementModel;
  ["highlighter"]: HighlighterElementModel;
};

export function isCanvasElementType(type: string): type is CanvasElementType {
  return type.toLocaleUpperCase() in CanvasElementType;
}
