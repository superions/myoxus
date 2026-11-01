import { type SlashMenuConfig } from "@virgultum/widget-slash-menu";

export const codeSlashMenuConfig: SlashMenuConfig = {
  disableWhen: ({ model }) => {
    return model.flavour === "myoxus:code";
  },
  items: [],
};
