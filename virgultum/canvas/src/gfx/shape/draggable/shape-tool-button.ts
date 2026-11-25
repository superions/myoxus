import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { type ShapeName, ShapeType } from "@virgultum/core/models";
import { NativeViewElement } from "@virgultum/core/runtime";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";

import { ShapeTool } from "../shape-tool.js";
import type { EdgelessToolbarShapeDraggable } from "./shape-draggable.js";
import type { EdgelessShapeMenu } from "./shape-menu.js";
import type { DraggableShape } from "./utils.js";

export class EdgelessShapeToolButton extends EdgelessToolbarToolMixin(
  NativeViewElement,
) {
  private _draggable: EdgelessToolbarShapeDraggable | null = null;

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

  private _ensureDraggable(): EdgelessToolbarShapeDraggable {
    let draggable = this._draggable;
    if (!draggable) {
      draggable = this.ownerDocument.createElement(
        "edgeless-toolbar-shape-draggable",
      ) as EdgelessToolbarShapeDraggable;
      Object.assign(draggable.style, {
        display: "block",
        width: "96px",
        height: "64px",
      });
      this._draggable = draggable;
    }
    draggable.edgeless = this.edgeless;
    draggable.toolbarContainer = this.toolbarContainer;
    draggable.onShapeClick = this._handleShapeClick;
    return draggable;
  }

  private readonly _mountArtwork = (host: HTMLElement) => {
    const draggable = this._ensureDraggable();
    host.append(draggable);
    return () => {
      draggable.remove();
    };
  };

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

  protected override paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    this._ensureDraggable();
    const { active } = this;

    this.mountSlot("tool", this, chrome.mountCanvasTool, {
      expanded: this.popper !== null,
      action: {
        id: "canvas-shape",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.keyboardShortcuts.shape", "Shape"),
          i18n,
        ),
        shortcut: "S",
        active,
        disabled: false,
        run: () => this._handleWrapperClick(),
      },
      artworkBounds: { width: 96, height: 64 },
      // Keep the generated artwork, drag controller and its original hit box.
      mountArtwork: this._mountArtwork,
    });
  }
}
