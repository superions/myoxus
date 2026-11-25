import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import {
  ThemeProvider,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { NativeViewElement } from "@virgultum/core/runtime";
import { EdgelessToolbarToolMixin } from "../../../../../widgets/edgeless-toolbar/index";

import { EraserTool } from "../../../eraser-tool";
import { EdgelessEraserDarkIcon, EdgelessEraserLightIcon } from "./icons.js";

export class EdgelessEraserToolButton extends EdgelessToolbarToolMixin(
  NativeViewElement,
) {
  override enableActiveBackground = false;

  override type = EraserTool;

  protected override onConnected() {
    this.disposables.add(
      this.edgeless.bindHotKey(
        {
          Escape: () => {
            if (this.edgelessTool?.toolType === EraserTool) {
              this.setEdgelessTool(DefaultTool);
            }
          },
        },
        { global: true },
      ),
    );
  }

  protected override paint() {
    const chrome = this.edgeless.std.getOptional(EditorChromeHostIdentifier);
    if (!chrome) return;
    const type = this.edgelessTool?.toolType;
    const appTheme = this.edgeless.std.get(ThemeProvider).app$.value;
    const i18n = this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
    void i18n?.locale$.value;
    const icon =
      appTheme === "dark" ? EdgelessEraserDarkIcon : EdgelessEraserLightIcon;

    this.mountSlot("tool", this, chrome.mountCanvasTool, {
      action: {
        id: "canvas-eraser",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.tool.eraser", "Eraser"),
          i18n,
        ),
        shortcut: "E",
        disabled: false,
        active: type === EraserTool,
        run: () => this.setEdgelessTool(EraserTool),
      },
      artworkSvg: icon,
      artworkBounds: { width: 49, height: 64 },
    });
  }
}
