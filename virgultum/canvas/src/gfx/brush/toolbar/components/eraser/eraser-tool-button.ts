import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import {
  ThemeProvider,
  EditorChromeHostIdentifier,
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { EdgelessToolbarToolMixin } from "../../../../../widgets/edgeless-toolbar/index";
import { LitElement } from "lit";

import { EraserTool } from "../../../eraser-tool";
import { EdgelessEraserDarkIcon, EdgelessEraserLightIcon } from "./icons.js";

export class EdgelessEraserToolButton extends EdgelessToolbarToolMixin(
  LitElement,
) {
  override createRenderRoot() {
    return this;
  }

  override enableActiveBackground = false;

  override type = EraserTool;

  override firstUpdated() {
    this.disposables.add(
      this.edgeless.bindHotKey(
        {
          Escape: () => {
            if (this.edgelessTool.toolType === EraserTool) {
              this.setEdgelessTool(DefaultTool);
            }
          },
        },
        { global: true },
      ),
    );
  }

  override render() {
    const type = this.edgelessTool?.toolType;
    const appTheme = this.edgeless.std.get(ThemeProvider).app$.value;
    const icon =
      appTheme === "dark" ? EdgelessEraserDarkIcon : EdgelessEraserLightIcon;

    return this.edgeless.std.get(EditorChromeHostIdentifier).renderCanvasTool({
      action: {
        id: "canvas-eraser",
        label: resolveEditorMessage(
          editorMessage("com.myoxus.editor.tool.eraser", "Eraser"),
          this.edgeless.std.getOptional(EditorI18nProvider) ?? undefined,
        ),
        shortcut: "E",
        disabled: false,
        active: type === EraserTool,
        run: () => this.setEdgelessTool(EraserTool),
      },
      artwork: icon,
      artworkBounds: { width: 49, height: 64 },
    });
  }
}
