import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { SignalWatcher } from "@virgultum/core/primitives/lit";
import { type ShapeName, ShapeType } from "@virgultum/core/models";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { html, LitElement } from "lit";

import { ShapeTool } from "../shape-tool.js";
import type { EdgelessShapeMenu } from "./shape-menu.js";
import type { DraggableShape } from "./utils.js";

export class EdgelessShapeToolButton extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement),
) {
  override createRenderRoot() {
    return this;
  }

  private readonly _handleShapeClick = (shape: DraggableShape) => {
    this.setEdgelessTool(this.type, {
      shapeName: shape.name,
    });
    if (!this.popper) this._toggleMenu();
  };

  private readonly _handleWrapperClick = () => {
    if (this.tryDisposePopper()) return;

    this.setEdgelessTool(this.type, {
      shapeName: ShapeType.Rect,
    });
    if (!this.popper) this._toggleMenu();
  };

  override type = ShapeTool;

  private _toggleMenu() {
    this.createPopper(
      "edgeless-shape-menu" as keyof HTMLElementTagNameMap,
      this,
      {
        setProps: (ele) => {
          const menu = ele as EdgelessShapeMenu;
          menu.edgeless = this.edgeless;
          menu.onChange = (shapeName: ShapeName) => {
            this.setEdgelessTool(this.type, {
              shapeName,
            });
            this._updateOverlay();
          };
        },
      },
    );
  }

  private _updateOverlay() {
    const controller = this.gfx.tool.currentTool$.peek();
    if (controller instanceof ShapeTool) {
      controller.createOverlay();
    }
  }

  override render() {
    const { active } = this;

    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      expanded: this.popper !== null,
      action: {
        id: "canvas-shape",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.keyboardShortcuts.shape", "Shape"),
          this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        shortcut: "S",
        active,
        disabled: false,
        run: () => this._handleWrapperClick(),
      },
      artworkBounds: { width: 96, height: 64 },
      // Keep the generated artwork, drag controller and its original hit box.
      artwork: html`<edgeless-toolbar-shape-draggable
        .edgeless=${this.edgeless}
        .toolbarContainer=${this.toolbarContainer}
        style="display:block;width:96px;height:64px"
        .onShapeClick=${this._handleShapeClick}
      ></edgeless-toolbar-shape-draggable>`,
    });
  }
}
