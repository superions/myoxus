import type { MindmapSourceBasis } from "../actions/mindmap-source";
import type { SerializedXYWH } from "@virgultum/editor/global/gfx";
import type { MindmapDesign as MindmapStyle } from "@virgultum/block-mermaid";
import type { GfxModel } from "@virgultum/editor/std/gfx";

import type { TemplateImage } from "../slides/template";

export interface ContextValue {
  selectedElements?: GfxModel[];
  content?: string;
  // make it real
  width?: number;
  height?: number;
  // mindmap
  node?: MindMapNode | null;
  mindmapSourceBasis?: MindmapSourceBasis;
  style?: MindmapStyle;
  centerPosition?: SerializedXYWH;
  // slides
  contents?: Array<{ blocks: MyoxusNode }>;
  images?: TemplateImage[][];
}

export interface MyoxusNode {
  id: string;
  flavour: string;
  children: MyoxusNode[];
}

type MindMapNode = {
  xywh?: SerializedXYWH;
  text: string;
  children: MindMapNode[];
};

export class AIContext {
  private _value: ContextValue;

  constructor(initData: ContextValue = {}) {
    this._value = initData;
  }

  get = () => {
    return this._value;
  };

  set = (data: ContextValue) => {
    this._value = {
      ...this._value,
      ...data,
    };
  };
}
