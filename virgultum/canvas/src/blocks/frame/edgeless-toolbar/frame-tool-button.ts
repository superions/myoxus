import {
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { NativeViewElement } from "@virgultum/core/runtime";
import { QuickToolMixin } from "../../../widgets/edgeless-toolbar/index";

import { FrameTool } from "../frame-tool";

type EdgelessFrameMenuElement = HTMLElement & {
  edgeless: EdgelessFrameToolButton["edgeless"];
};

export class EdgelessFrameToolButton extends QuickToolMixin(NativeViewElement) {
  override type = FrameTool;

  private _toggleFrameMenu() {
    if (this.tryDisposePopper()) return;

    this.createPopper("edgeless-frame-menu" as never, this, {
      setProps: (ele) => {
        (ele as EdgelessFrameMenuElement).edgeless = this.edgeless;
      },
    });
  }

  protected override paint() {
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const type = this.edgelessTool?.toolType?.toolName;
    this.mountSlot("tool", this, chrome.mountCanvasTool, {
      expanded: this.popper !== null,
      action: {
        id: "canvas-frame",
        icon: "FrameIcon",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.slash.frame", "Frame"),
          i18n,
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
