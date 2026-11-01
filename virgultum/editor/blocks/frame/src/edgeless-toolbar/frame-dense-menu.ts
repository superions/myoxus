import { editorMessage } from "@virgultum/shared/services";
import { FrameIcon } from "@myoxus/icons/lit";
import { DefaultTool } from "@virgultum/block-surface";
import { menu } from "@virgultum/components/context-menu";
import type { DenseMenuBuilder } from "@virgultum/widget-edgeless-toolbar";

import { EdgelessFrameManagerIdentifier } from "../frame-manager.js";
import { FrameTool } from "../frame-tool";
import { FrameConfig } from "./config.js";

export const buildFrameDenseMenu: DenseMenuBuilder = (edgeless, gfx) =>
  menu.subMenu({
    name: "Frame",
    label: editorMessage("com.myoxus.editor.slash.frame", "Frame"),
    prefix: FrameIcon({ width: "20px", height: "20px" }),
    select: () => gfx.tool.setTool(FrameTool),
    isSelected: gfx.tool.currentToolName$.peek() === "frame",
    options: {
      items: [
        menu.action({
          name: "Custom",
          label: editorMessage("com.myoxus.editor.frame.custom", "Custom"),
          select: () => gfx.tool.setTool(FrameTool),
        }),
        ...FrameConfig.map((config) =>
          menu.action({
            name: `Slide ${config.name}`,
            label: editorMessage(
              "com.myoxus.editor.frame.slide",
              "Slide {{name}}",
              { name: config.name },
            ),
            select: () => {
              const frame = edgeless.std.get(EdgelessFrameManagerIdentifier);
              gfx.tool.setTool(DefaultTool);
              frame.createFrameOnViewportCenter(config.wh);
            },
          }),
        ),
      ],
    },
  });
