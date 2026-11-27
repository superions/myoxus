import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import { PanTool } from "@virgultum/canvas-runtime/tools";
import {
  EditorI18nProvider,
  editorMessage,
  resolveEditorMessage,
} from "@virgultum/core/services";
import { QuickToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const defaultQuickTool = QuickToolExtension(
  "default",
  ({ block, gfx, closeActivePopover }) => {
    const mode = gfx.tool.currentToolName$.peek();
    const hand = mode === "pan";
    return {
      priority: 100,
      type: "default",
      content: {
        type: "control",
        controls: {
          action: {
            id: "canvas-pointer",
            icon:
              localStorage.defaultTool === "pan" ? "HandIcon" : "SelectIcon",
            label: resolveEditorMessage(
              hand
                ? editorMessage("com.myoxus.keyboardShortcuts.hand", "Hand")
                : editorMessage(
                    "com.myoxus.keyboardShortcuts.select",
                    "Select",
                  ),
              block.std.getOptional(EditorI18nProvider) ?? undefined,
            ),
            shortcut: hand ? "H" : "V",
            active: hand || mode === "default",
            disabled: false,
            run: () => {
              closeActivePopover();
              const current = gfx.tool.currentToolName$.peek();
              if (
                current === "default" ||
                (current !== "pan" && localStorage.defaultTool === "pan")
              )
                gfx.tool.setTool(PanTool, { panning: false });
              else gfx.tool.setTool(DefaultTool);
            },
          },
        },
      },
    };
  },
);
