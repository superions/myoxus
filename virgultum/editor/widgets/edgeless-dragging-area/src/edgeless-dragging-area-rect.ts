import { cssVar } from "@myoxus/theme";
import { DefaultModeDragType, DefaultTool } from "@virgultum/block-surface";
import type { RootBlockModel } from "@virgultum/model";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { css, html, nothing, unsafeCSS } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { literal, unsafeStatic } from "lit/static-html.js";

export const EDGELESS_DRAGGING_AREA_WIDGET = "edgeless-dragging-area-rect";

export class EdgelessDraggingAreaRectWidget extends WidgetComponent<RootBlockModel> {
  static override styles = css`
    .myoxus-edgeless-dragging-area {
      position: absolute;
      background: ${unsafeCSS(cssVar("primaryColor04"))};
      box-sizing: border-box;
      border-width: 1px;
      border-style: solid;
      border-color: ${unsafeCSS(cssVar("primaryColor"))};

      z-index: 1;
      pointer-events: none;
    }
  `;

  get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  override render() {
    const rect = this.gfx.tool.draggingViewportArea$.value;
    const tool = this.gfx.tool.currentTool$.value;

    if (
      rect.w === 0 ||
      rect.h === 0 ||
      !tool ||
      !(tool instanceof DefaultTool) ||
      tool.dragType !== DefaultModeDragType.Selecting
    )
      return nothing;

    const style = {
      left: rect.x + "px",
      top: rect.y + "px",
      width: rect.w + "px",
      height: rect.h + "px",
    };

    return html`
      <div class="myoxus-edgeless-dragging-area" style=${styleMap(style)}></div>
    `;
  }
}

export const edgelessDraggingAreaWidget = WidgetViewExtension(
  "myoxus:page",
  EDGELESS_DRAGGING_AREA_WIDGET,
  literal`${unsafeStatic(EDGELESS_DRAGGING_AREA_WIDGET)}`,
);
