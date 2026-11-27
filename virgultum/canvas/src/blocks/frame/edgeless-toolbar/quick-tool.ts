import { QuickToolExtension } from "../../../widgets/edgeless-toolbar/index";

import { buildFrameDenseMenu } from "./frame-dense-menu";

export const frameQuickTool = QuickToolExtension("frame", ({ block, gfx }) => {
  return {
    type: "frame",
    content: {
      type: "popover-tool",
      tool: "frame",
      edgeless: block,
    },
    menu: buildFrameDenseMenu(block, gfx),
    enable: !block.store.readonly,
    priority: 90,
  };
});
