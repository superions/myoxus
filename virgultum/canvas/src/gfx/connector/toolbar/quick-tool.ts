import { QuickToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const connectorQuickTool = QuickToolExtension(
  "connector",
  ({ block }) => {
    return {
      type: "connector",
      content: {
        type: "hosts",
        tags: ["edgeless-connector-tool-button"],
        edgeless: block,
      },
      priority: 80,
    };
  },
);
