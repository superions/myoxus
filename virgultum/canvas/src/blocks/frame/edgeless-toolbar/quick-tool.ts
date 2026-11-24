import { QuickToolExtension } from "../../../widgets/edgeless-toolbar/index";

import { buildFrameDenseMenu } from "./frame-dense-menu";

export const frameQuickTool = QuickToolExtension("frame", ({ block, gfx }) => {
  return {
    type: "frame",
    content: {
      type: "hosts",
      tags: ["edgeless-frame-tool-button"],
      edgeless: block,
    },
    menu: buildFrameDenseMenu(block, gfx),
    enable: !block.store.readonly,
    priority: 90,
  };
});
