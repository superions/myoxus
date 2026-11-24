import { QuickToolExtension } from "../../../widgets/edgeless-toolbar/index";

export const defaultQuickTool = QuickToolExtension("default", ({ block }) => {
  return {
    priority: 100,
    type: "default",
    content: {
      type: "hosts",
      tags: ["edgeless-default-tool-button"],
      edgeless: block,
    },
  };
});
