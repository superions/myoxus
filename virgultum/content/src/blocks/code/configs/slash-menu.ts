import { type SlashMenuConfig } from "@virgultum/core/slash-menu";

export const codeSlashMenuConfig: SlashMenuConfig = {
  disableWhen: ({ model }) => {
    return model.flavour === "myoxus:code";
  },
  items: [],
};
