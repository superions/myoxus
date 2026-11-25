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
import { NativeViewElement } from "@virgultum/core/runtime";
import type { ToolOptionWithType } from "@virgultum/core/runtime/gfx";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";

import { TemplateTool } from "../template-tool";
import type { EdgelessTemplatePanel } from "./template-panel.js";

export class EdgelessTemplateButton extends EdgelessToolbarToolMixin(
  NativeViewElement,
) {
  private _cleanup: (() => void) | null = null;
  private _autoUpdateCleanup: (() => void) | null = null;
  private _openedPanel: EdgelessTemplatePanel | null = null;
  private _prevTool: ToolOptionWithType | null = null;

  override enableActiveBackground = false;

  override type = TemplateTool;

  protected override onConnected() {
    this.disposables.add(() => {
      this._autoUpdateCleanup?.();
      this._autoUpdateCleanup = null;
    });
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
    this.requestUpdate();

    this.append(panel);

    requestAnimationFrame(() => {
      const arrowEl = panel.querySelector(".arrow") as HTMLElement | null;
      if (!arrowEl) return;
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

  protected override paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    this.mountSlot("tool", this, chrome.mountCanvasTool, {
      expanded: this._openedPanel !== null,
      action: {
        id: "canvas-template",
        icon: "LayoutTemplateIcon",
        label: resolveEditorMessage(
          editorMessage("Template", "Template"),
          i18n,
        ),
        disabled: false,
        active: this._openedPanel !== null,
        run: () => this._togglePanel(),
      },
    });
  }
}
