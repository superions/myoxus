import {
  editorMessage,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { NativeViewElement } from "@virgultum/core/runtime";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";

import { EdgelessFrameManagerIdentifier } from "../frame-manager.js";
import { FrameTool } from "../frame-tool";
import { FrameConfig } from "./config.js";

export class EdgelessFrameMenu extends EdgelessToolbarToolMixin(
  NativeViewElement,
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  override type = FrameTool;

  get frameManager() {
    return this.edgeless.std.get(EdgelessFrameManagerIdentifier);
  }

  protected override paint() {
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const { gfx, frameManager } = this;
    this.mountSlot("menu", this, chrome.mountCanvasMenu, {
      actions: [
        {
          id: "canvas-frame-custom",
          label: this._text(
            editorMessage("com.myoxus.editor.frame.custom", "Custom"),
          ),
          disabled: false,
        },
        ...FrameConfig.map((item) => ({
          id: `canvas-frame-${item.name}`,
          label: item.name,
          showLabel: true,
          disabled: false,
          run: () => {
            gfx.tool.setTool(DefaultTool);
            frameManager.createFrameOnViewportCenter(item.wh);
          },
        })),
      ],
    });
  }
}
