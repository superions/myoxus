import { SignalWatcher } from "@virgultum/global/lit";
import { type ShapeName, ShapeType } from "@virgultum/model";
import { EdgelessToolbarToolMixin } from "@virgultum/widget-edgeless-toolbar";
import { css, html, LitElement } from "lit";

import { ShapeTool } from "../shape-tool.js";
import type { EdgelessShapeMenu } from "./shape-menu.js";
import type { DraggableShape } from "./utils.js";

export class EdgelessShapeToolButton extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement),
) {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }
    edgeless-toolbar-button,
    .shapes {
      width: 100%;
      height: 64px;
    }
  `;

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

    return html`
      <edgeless-toolbar-button
        class="edgeless-shape-button"
        .tooltip=${
          this.popper
            ? ""
            : html`<myoxus-tooltip-content-with-shortcut
                data-tip="${"Shape"}"
                data-shortcut="${"S"}"
              ></myoxus-tooltip-content-with-shortcut>`
        }
        .tooltipOffset=${5}
        .active=${active}
      >
        <edgeless-toolbar-shape-draggable
          .edgeless=${this.edgeless}
          .toolbarContainer=${this.toolbarContainer}
          class="shapes"
          @click=${this._handleWrapperClick}
          .onShapeClick=${this._handleShapeClick}
        >
        </edgeless-toolbar-shape-draggable>
      </edgeless-toolbar-button>
    `;
  }
}
