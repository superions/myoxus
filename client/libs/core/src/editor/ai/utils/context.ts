// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MindmapDesign } from "@virgultum/block-mermaid";
import type { SerializedXYWH } from "@virgultum/editor/global/gfx";
import type { GfxModel } from "@virgultum/editor/std/gfx";

import type { MindmapSourceBasis } from "../actions/mindmap-source";
import type { TemplateImage } from "../slides/slide-builder";

export interface MyoxusNode {
  id: string;
  flavour: string;
  children: MyoxusNode[];
}

export interface MindMapNode {
  xywh?: SerializedXYWH;
  text: string;
  children: MindMapNode[];
}

export interface ContextValue {
  selectedElements?: GfxModel[];
  content?: string;
  width?: number;
  height?: number;
  node?: MindMapNode | null;
  mindmapSourceBasis?: MindmapSourceBasis;
  style?: MindmapDesign;
  centerPosition?: SerializedXYWH;
  contents?: Array<{ blocks: MyoxusNode }>;
  images?: TemplateImage[][];
}

export class AIContext {
  private state: ContextValue;

  constructor(initial: ContextValue = {}) {
    this.state = initial;
  }

  get = (): ContextValue => this.state;

  set = (patch: ContextValue): void => {
    this.state = { ...this.state, ...patch };
  };
}
