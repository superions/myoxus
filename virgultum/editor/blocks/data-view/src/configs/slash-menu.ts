import { FeatureFlagService } from "@virgultum/shared/services";
import { isInsideBlockByFlavour } from "@virgultum/shared/utils";
import { type SlashMenuConfig } from "@virgultum/widget-slash-menu";

import type { DataViewBlockComponent } from "../data-view-block";

export const dataViewSlashMenuConfig: SlashMenuConfig = {
  disableWhen: ({ model }) => {
    return model.flavour === "myoxus:data-view";
  },
  items: [
    {
      name: "Todo",
      searchAlias: ["todo view"],
      icon: "DatabaseTableViewIcon",
      tooltip: {
        caption: "To-do List",
      },
      group: "7_Database@1",
      when: ({ model, std }) =>
        !isInsideBlockByFlavour(model.store, model, "myoxus:edgeless-text") &&
        !!std.get(FeatureFlagService).getFlag("enable_block_query"),

      action: ({ model, std }) => {
        const { host } = std;
        const parent = host.store.getParent(model);
        if (!parent) return;
        const index = parent.children.indexOf(model);
        const id = host.store.addBlock(
          "myoxus:data-view",
          {},
          host.store.getParent(model),
          index + 1,
        );
        const dataViewModel = host.store.getBlock(id)!;

        const dataView = std.view.getBlock(
          dataViewModel.id,
        ) as DataViewBlockComponent | null;
        dataView?.dataSource.viewManager.viewAdd("table");

        if (model.text?.length === 0) {
          model.store.deleteBlock(model);
        }
      },
    },
  ],
};
