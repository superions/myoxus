import {
  editorMessage,
  EditorI18nProvider,
  resolveEditorMessage,
  type EditorI18nMessage,
} from "@virgultum/core/services";
import { DefaultTool } from "@virgultum/canvas-runtime/surface";
import type { DenseMenuBuilder } from "../../../widgets/edgeless-toolbar/index";

import { EdgelessFrameManagerIdentifier } from "../frame-manager.js";
import { FrameTool } from "../frame-tool";
import { FrameConfig } from "./config.js";

export const buildFrameDenseMenu: DenseMenuBuilder = (edgeless, gfx) => {
  const i18n = edgeless.std.getOptional(EditorI18nProvider) ?? undefined;
  const text = (message: EditorI18nMessage) =>
    resolveEditorMessage(message, i18n);
  return {
    id: "canvas-overflow-frame",
    label: text(editorMessage("com.myoxus.editor.slash.frame", "Frame")),
    icon: "FrameIcon",
    disabled: edgeless.store.readonly,
    active: gfx.tool.currentToolName$.peek() === "frame",
    // Clicking the parent selects the custom frame tool; hovering exposes presets.
    run: () => gfx.tool.setTool(FrameTool),
    control: {
      type: "menu",
      items: [
        {
          id: "canvas-overflow-frame-custom",
          label: text(
            editorMessage("com.myoxus.editor.frame.custom", "Custom"),
          ),
          disabled: edgeless.store.readonly,
          run: () => gfx.tool.setTool(FrameTool),
        },
        ...FrameConfig.map((config) => ({
          id: `canvas-overflow-frame-${config.name}`,
          label: text(
            editorMessage("com.myoxus.editor.frame.slide", "Slide {{name}}", {
              name: config.name,
            }),
          ),
          disabled: edgeless.store.readonly,
          run: () => {
            const frame = edgeless.std.get(EdgelessFrameManagerIdentifier);
            gfx.tool.setTool(DefaultTool);
            frame.createFrameOnViewportCenter(config.wh);
          },
        })),
      ],
    },
  };
};
