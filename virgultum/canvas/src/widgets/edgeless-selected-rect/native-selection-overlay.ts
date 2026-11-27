// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { NativeViewElement } from "@virgultum/core/runtime";
import { effect, untracked } from "@preact/signals-core";
import {
  type BlockStdScope,
  editorHostSelector,
  isEditorHost,
} from "@virgultum/core/runtime";
import { stopPropagation } from "@virgultum/core/utils";

import type { NoteBlockModel, ShapeElementModel } from "@virgultum/core/models";

import { AutoCompleteController } from "./auto-complete-controller";
import {
  CanvasSelectionController,
  canvasSelectionCss,
} from "./edgeless-selected-rect";

type SelectionViewState = NonNullable<
  ReturnType<CanvasSelectionController["read"]>
>;

function syncTargets(container: HTMLElement, targets: HTMLElement[]) {
  // Reuse the actual connected nodes during a pointer gesture.
  targets.forEach((target, i) => {
    const current = container.children.item(i);
    if (current !== target) container.insertBefore(target, current);
  });
  while (container.children.length > targets.length) {
    container.lastElementChild?.remove();
  }
}

export class EdgelessSelectedRectWidget extends NativeViewElement {
  private readonly overlay: ShadowRoot;
  private readonly rect = this.ownerDocument.createElement("div");
  private autoComplete?: AutoCompleteController;
  private connector?: HTMLElementTagNameMap["edgeless-connector-handle"];
  private outlines = new Map<string, HTMLElement>();
  private controller?: CanvasSelectionController;
  private disposeRender?: () => void;

  constructor() {
    super();
    this.overlay = this.attachShadow({ mode: "open" });
    const style = this.ownerDocument.createElement("style");
    style.textContent = canvasSelectionCss;
    this.overlay.append(style);
    this.rect.className = "myoxus-edgeless-selected-rect";
    this.rect.setAttribute("disabled", "true");
  }

  set autoCompleteOff(value: boolean) {
    if (this.controller) this.controller.autoCompleteOff.value = value;
  }

  connectedCallback() {
    const owner = this.closest(editorHostSelector);
    if (!isEditorHost(owner)) return;
    const { std } = owner;
    const controller = new CanvasSelectionController(this, std);
    this.controller = controller;
    this.addEventListener("pointerdown", stopPropagation);
    controller.bind();

    this.disposeRender = effect(() => {
      const state = controller.read();
      untracked(() => this.paint(state, std));
    });
  }

  private paint(state: SelectionViewState | null, std: BlockStdScope) {
    if (!state) {
      this.autoComplete?.updateSelection(null, null);
      this.clearOverlay(false);
      return;
    }

    this.drawSelection(state);
    const block = std.store.root && std.view.getBlock(std.store.root.id);
    if (block) {
      const controller = (this.autoComplete ??= new AutoCompleteController(
        block,
      ));
      controller.updateSelection(
        (state.autoComplete as ShapeElementModel | NoteBlockModel | null) ??
          null,
        state.autoComplete ? state.rect : null,
      );
    } else {
      this.autoComplete?.updateSelection(null, null);
    }

    const targets: HTMLElement[] = [...state.targets];
    if (state.connector) {
      const connector = (this.connector ??= this.ownerDocument.createElement(
        "edgeless-connector-handle",
      ));
      connector.std = std;
      connector.connector = state.connector;
      targets.push(connector);
    } else {
      this.connector = undefined;
    }
    const outlines = new Map<string, HTMLElement>();
    for (const { id, style } of state.outlines) {
      let outline = this.outlines.get(id);
      if (!outline) {
        outline = this.ownerDocument.createElement("div");
        outline.className = "element-handle";
      }
      Object.assign(outline.style, style);
      outlines.set(id, outline);
      targets.push(outline);
    }
    this.outlines = outlines;
    syncTargets(this.rect, targets);
  }

  disconnectedCallback() {
    this.disposeRender?.();
    this.controller?.dispose();
    this.disposeRender = undefined;
    this.controller = undefined;
    this.clearOverlay(true);
    this.removeEventListener("pointerdown", stopPropagation);
  }

  private clearOverlay(disposeAutoComplete: boolean) {
    if (disposeAutoComplete) {
      this.autoComplete?.dispose();
      this.autoComplete = undefined;
    }
    this.connector = undefined;
    this.outlines.clear();
    this.rect.replaceChildren();
    this.rect.remove();
  }

  private drawSelection(state: SelectionViewState) {
    const { rect } = this;
    if (!rect.isConnected) this.overlay.append(rect);
    const { width, height, borderWidth, borderStyle, left, top, rotate } =
      state.rect;
    Object.assign(rect.style, {
      width: `${width}px`,
      height: `${height}px`,
      borderWidth: `${borderWidth}px`,
      borderStyle: state.isConnector ? "none" : borderStyle,
      transform: `translate(${left}px, ${top}px) rotate(${rotate}deg)`,
    });
    rect.dataset.mode = state.mode;
    rect.dataset.locked = String(state.locked);
    rect.dataset.widthLimit = String(state.widthLimit);
    rect.dataset.heightLimit = String(state.heightLimit);
    if (state.scalePercent) rect.dataset.scalePercent = state.scalePercent;
    else delete rect.dataset.scalePercent;
    if (state.scaleDirection)
      rect.dataset.scaleDirection = state.scaleDirection;
    else delete rect.dataset.scaleDirection;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "edgeless-selected-rect": EdgelessSelectedRectWidget;
  }
}
