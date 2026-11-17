import {
  editorMessage,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { SignalWatcher } from "@virgultum/core/primitives/lit";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { EdgelessToolbarToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";

import { EdgelessFrameManagerIdentifier } from "../frame-manager.js";
import { FrameTool } from "../frame-tool";
import { FrameConfig } from "./config.js";

export class EdgelessFrameMenu extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement),
) {
  private _text(message: EditorI18nMessage) {
    return resolveEditorMessage(
      message,
      this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
    );
  }

  override createRenderRoot() {
    return this;
  }

  override type = FrameTool;

  get frameManager() {
    return this.edgeless.std.get(EdgelessFrameManagerIdentifier);
  }

  override render() {
    const { gfx, frameManager } = this;
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasMenu({
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
