import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { QuickToolMixin } from "../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";

import { FrameTool } from "../frame-tool";

type EdgelessFrameMenuElement = HTMLElement & {
  edgeless: EdgelessFrameToolButton["edgeless"];
};

export class EdgelessFrameToolButton extends QuickToolMixin(LitElement) {
  override createRenderRoot() {
    return this;
  }

  override type = FrameTool;

  private _toggleFrameMenu() {
    if (this.tryDisposePopper()) return;

    const menu = this.createPopper("edgeless-frame-menu" as never, this);
    (menu.element as EdgelessFrameMenuElement).edgeless = this.edgeless;
  }

  override render() {
    const type = this.edgelessTool?.toolType?.toolName;
    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      expanded: this.popper !== null,
      action: {
        id: "canvas-frame",
        icon: "FrameIcon",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.slash.frame", "Frame"),
          this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        shortcut: "F",
        active: type === "frame",
        disabled: false,
        run: () => {
          this._toggleFrameMenu();
          this.setEdgelessTool(FrameTool);
        },
      },
    });
  }
}
