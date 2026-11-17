import { effect } from "@preact/signals-core";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { QuickToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";
import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";

import { PanTool } from "@virgultum/canvas-runtime/tools";

export class EdgelessDefaultToolButton extends QuickToolMixin(LitElement) {
  override createRenderRoot() {
    return this;
  }

  override type = [DefaultTool, PanTool];

  private _changeTool() {
    if (this.toolbar.activePopper) {
      // click manually always closes the popper
      this.toolbar.activePopper.dispose();
    }
    const type = this.edgelessTool?.toolType?.toolName;
    if (type !== "default" && type !== "pan") {
      if (localStorage.defaultTool === "default") {
        this.setEdgelessTool(DefaultTool);
      } else if (localStorage.defaultTool === "pan") {
        this.setEdgelessTool(PanTool, { panning: false });
      }
      return;
    }
    if (type === "default") this.setEdgelessTool(PanTool, { panning: false });
    else if (type === "pan") this.setEdgelessTool(DefaultTool);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (!localStorage.defaultTool) {
      localStorage.defaultTool = "default";
    }
    this.disposables.add(
      effect(() => {
        const tool = this.gfx.tool.currentToolName$.value;
        if (tool === "default" || tool === "pan") {
          localStorage.defaultTool = tool;
        }
      }),
    );
  }

  override render() {
    const type = this.edgelessTool?.toolType?.toolName;
    const { active } = this;
    const tipInfo =
      type === "pan"
        ? { tip: "Hand", shortcut: "H" }
        : { tip: "Select", shortcut: "V" };
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      action: {
        id: "canvas-pointer",
        label: resolveEditorMessage(
          editorMessage(
            type === "pan"
              ? "com.myoxus.keyboardShortcuts.hand"
              : "com.myoxus.keyboardShortcuts.select",
            tipInfo.tip,
          ),
          i18n,
        ),
        shortcut: tipInfo.shortcut,
        icon:
          localStorage.defaultTool === "default" ? "SelectIcon" : "HandIcon",
        disabled: false,
        active,
        run: () => this._changeTool(),
      },
    });
  }
}
