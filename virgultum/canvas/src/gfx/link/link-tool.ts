import { QuickToolExtension } from "../../widgets/edgeless-toolbar/index";

import { buildLinkDenseMenu } from "./toolbar/link-dense-menu";

export const linkQuickTool = QuickToolExtension("link", ({ block, gfx }) => {
  return {
    content: {
      type: "hosts",
      tags: ["edgeless-link-tool-button"],
      edgeless: block,
    },
    menu: buildLinkDenseMenu(block, gfx),
  };
});
