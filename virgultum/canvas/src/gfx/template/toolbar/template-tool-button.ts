import {
  arrow,
  autoUpdate,
  computePosition,
  offset,
  shift,
} from "@floating-ui/dom";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  resolveEditorMessage,
  editorMessage,
} from "@virgultum/core/services";
import { once } from "@virgultum/core/utils";
import type { ToolOptionWithType } from "@virgultum/core/runtime/gfx";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";
import { state } from "lit/decorators.js";

import { TemplateTool } from "../template-tool";
import type { EdgelessTemplatePanel } from "./template-panel.js";

export class EdgelessTemplateButton extends EdgelessToolbarToolMixin(
  LitElement,
) {
  private _cleanup: (() => void) | null = null;
  private _autoUpdateCleanup: (() => void) | null = null;

  private _prevTool: ToolOptionWithType | null = null;

  override enableActiveBackground = false;

  override createRenderRoot() {
    return this;
  }

  override type = TemplateTool;

  override connectedCallback() {
    super.connectedCallback();
    this.disposables.add(() => this._autoUpdateCleanup?.());
  }

  private _closePanel() {
    if (this._openedPanel) {
      this._autoUpdateCleanup?.();
      this._autoUpdateCleanup = null;
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
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      expanded: this._openedPanel !== null,
      action: {
        id: "canvas-template",
        icon: "LayoutTemplateIcon",
        label: resolveEditorMessage(
          editorMessage("Template", "Template"),
          this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        disabled: false,
        active: this._openedPanel !== null,
        run: () => this._togglePanel(),
      },
    });
  }

  @state()
  private accessor _openedPanel: EdgelessTemplatePanel | null = null;
}
