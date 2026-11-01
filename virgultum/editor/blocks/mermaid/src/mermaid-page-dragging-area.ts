// SPDX-License-Identifier: AGPL-3.0-or-later

import { cssVar } from "@myoxus/theme";
import { DefaultModeDragType } from "@virgultum/block-surface";
import type { RootBlockModel } from "@virgultum/model";
import { WidgetComponent, WidgetViewExtension } from "@virgultum/std";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { css, html, nothing, unsafeCSS } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { literal } from "lit/static-html.js";

import { MermaidPageSelectionTool } from "./mermaid-page-selection-tool.js";

export const MERMAID_PAGE_DRAGGING_AREA_WIDGET = "mermaid-page-dragging-area";

export class MermaidPageDraggingAreaWidget extends WidgetComponent<RootBlockModel> {
  static override styles = css`
    .myoxus-mermaid-page-dragging-area {
      position: absolute;
      z-index: 1;
      box-sizing: border-box;
      border: 1px solid ${unsafeCSS(cssVar("primaryColor"))};
      background: ${unsafeCSS(cssVar("primaryColor04"))};
      pointer-events: none;
    }
  `;

  override render() {
    const gfx = this.std.get(GfxControllerIdentifier);
    const tool = gfx.tool.currentTool$.value;
    const rect = gfx.tool.draggingViewportArea$.value;
    if (
      !(tool instanceof MermaidPageSelectionTool) ||
      !tool.movementDragging ||
      tool.dragType !== DefaultModeDragType.Selecting ||
      rect.w === 0 ||
      rect.h === 0
    ) {
      return nothing;
    }
    return html`<div
      aria-hidden="true"
      class="myoxus-mermaid-page-dragging-area"
      style=${styleMap({
        height: `${rect.h}px`,
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
      })}
    ></div>`;
  }
}

export const mermaidPageDraggingAreaExtension = WidgetViewExtension(
  "myoxus:page",
  MERMAID_PAGE_DRAGGING_AREA_WIDGET,
  literal`mermaid-page-dragging-area`,
);

declare global {
  interface HTMLElementTagNameMap {
    "mermaid-page-dragging-area": MermaidPageDraggingAreaWidget;
  }
}
