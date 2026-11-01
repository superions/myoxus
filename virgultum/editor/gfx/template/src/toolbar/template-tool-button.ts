import {
  arrow,
  autoUpdate,
  computePosition,
  offset,
  shift,
} from "@floating-ui/dom";
import { DefaultTool } from "@virgultum/block-surface";
import { LayoutTemplateIcon } from "@myoxus/icons/lit";
import { once } from "@virgultum/shared/utils";
import type { ToolOptionWithType } from "@virgultum/std/gfx";
import { EdgelessToolbarToolMixin } from "@virgultum/widget-edgeless-toolbar";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";

import { TemplateTool } from "../template-tool";
import type { EdgelessTemplatePanel } from "./template-panel.js";

export class EdgelessTemplateButton extends EdgelessToolbarToolMixin(
  LitElement,
) {
  private _cleanup: (() => void) | null = null;
  private _autoUpdateCleanup: (() => void) | null = null;

  private _prevTool: ToolOptionWithType | null = null;

  override enableActiveBackground = true;

  override type = TemplateTool;

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(() => this._autoUpdateCleanup?.());
  }

  private _closePanel() {
    if (this._openedPanel) {
      this._openedPanel.remove();
      this._openedPanel = null;
      this._cleanup?.();
      this._cleanup = null;
      this.requestUpdate();

      if (
        this._prevTool &&
        this._prevTool.toolType &&
        this._prevTool.toolType !== TemplateTool
      ) {
        this.setEdgelessTool(this._prevTool.toolType, this._prevTool.options);
        this._prevTool = null;
      } else {
        this.setEdgelessTool(DefaultTool);
      }
    }
  }

  private _togglePanel() {
    if (this._openedPanel) {
      this._closePanel();
      if (this._prevTool && this._prevTool.toolType) {
        this.setEdgelessTool(this._prevTool.toolType, this._prevTool.options);
        this._prevTool = null;
      }
      return;
    }

    this._prevTool = this.edgelessTool ? { ...this.edgelessTool } : null;

    this.setEdgelessTool(TemplateTool);

    const panel = document.createElement("edgeless-templates-panel");
    panel.edgeless = this.edgeless;

    this._cleanup = once(panel, "closepanel", () => {
      this._closePanel();
    });
    this._openedPanel = panel;

    this.renderRoot.append(panel);

    requestAnimationFrame(() => {
      const arrowEl = panel.renderRoot.querySelector(".arrow") as HTMLElement;
      this._autoUpdateCleanup?.();
      this._autoUpdateCleanup = autoUpdate(this, panel, () => {
        computePosition(this, panel, {
          placement: "top",
          middleware: [offset(20), arrow({ element: arrowEl }), shift()],
        })
          .then(({ x, y, middlewareData }) => {
            panel.style.left = `${x}px`;
            panel.style.top = `${y}px`;

            arrowEl.style.left = `${
              (middlewareData.arrow?.x ?? 0) - (middlewareData.shift?.x ?? 0)
            }px`;
          })
          .catch((e) => {
            console.warn("Can't compute position", e);
          });
      });
    });
  }

  override render() {
    return html`<edgeless-tool-icon-button
      .active=${this._openedPanel !== null}
      @click=${this._togglePanel}
    >
      ${LayoutTemplateIcon()}
    </edgeless-tool-icon-button>`;
  }

  @state()
  private accessor _openedPanel: EdgelessTemplatePanel | null = null;
}
