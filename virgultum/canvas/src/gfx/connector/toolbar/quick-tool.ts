import { QuickToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const connectorQuickTool = QuickToolExtension(
  "connector",
  ({ block }) => {
    return {
      type: "connector",
      content: {
        type: "popover-tool",
        tool: "connector",
        edgeless: block,
      },
      priority: 80,
    };
  },
);
