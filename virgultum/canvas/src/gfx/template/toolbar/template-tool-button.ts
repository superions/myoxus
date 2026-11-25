import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import {
  EditorChromeHostIdentifier,
  type EditorCanvasPopoverControls,
  EditorI18nProvider,
  resolveEditorMessage,
  editorMessage,
} from "@virgultum/core/services";
import { NativeViewElement } from "@virgultum/core/runtime";
import type { ToolOptionWithType } from "@virgultum/core/runtime/gfx";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";

import { TemplateTool } from "../template-tool";
import type { EdgelessTemplatePanel } from "./template-panel.js";

export class EdgelessTemplateButton extends EdgelessToolbarToolMixin(
  NativeViewElement,
) {
  private _opened = false;
  private _prevTool: ToolOptionWithType | null = null;
  private _panelEl: EdgelessTemplatePanel | null = null;

  override enableActiveBackground = false;

  override type = TemplateTool;

  private _closePanel = () => {
    if (!this._opened) return;
    if (this._panelEl?.isDragging) return;
    this._opened = false;
    this._panelEl = null;
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
  };

  private _togglePanel = () => {
    if (this._opened) {
      this._closePanel();
      return;
    }

    this._prevTool = this.edgelessTool ? { ...this.edgelessTool } : null;
    this.setEdgelessTool(TemplateTool);
    this._opened = true;
    this.requestUpdate();
  };

  private readonly _mountPanel = (host: HTMLElement) => {
    const panel = this.ownerDocument.createElement(
      "edgeless-templates-panel",
    ) as EdgelessTemplatePanel;
    panel.edgeless = this.edgeless;
    const onClose = () => this._closePanel();
    panel.addEventListener("closepanel", onClose);
    this._panelEl = panel;
    host.append(panel);
    return () => {
      panel.removeEventListener("closepanel", onClose);
      panel.remove();
      if (this._panelEl === panel) {
        this._panelEl = null;
      }
    };
  };

  protected override paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome?.mountCanvasPopover) return;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const label = resolveEditorMessage(
      editorMessage("Template", "Template"),
      i18n,
    );
    const controls: EditorCanvasPopoverControls = {
      opened: this._opened,
      onClose: this._closePanel,
      position: "top",
      offset: 16,
      withArrow: true,
      closeOnClickOutside: true,
      label,
      trigger: {
        expanded: this._opened,
        action: {
          id: "canvas-template",
          icon: "LayoutTemplateIcon",
          label,
          disabled: false,
          active: this._opened,
          run: this._togglePanel,
        },
      },
      content: {
        kind: "native",
        mount: this._mountPanel,
      },
    };
    this.mountSlot("tool", this, chrome.mountCanvasPopover, controls);
  }
}
