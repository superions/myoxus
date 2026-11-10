import { MyoxusCommandRegistry } from "@myoxus/core/commands";
import { NewXxxEdgelessIcon, NewXxxPageIcon } from "@myoxus/icons/react";
import { Entity, LiveData } from "@myoxus/infra";
import type { DocMode } from "@virgultum/editor/model";

import type { QuickSearchSession } from "../providers/quick-search-provider";
import type { QuickSearchGroup } from "../types/group";
import type { QuickSearchItem } from "../types/item";
import { isCommandAvailable } from "./commands";

const group = {
  id: "creation",
  label: { i18nKey: "Create" },
  score: -1,
} as QuickSearchGroup;

export class CreationQuickSearchSession
  extends Entity
  implements QuickSearchSession<"creation", { title: string; mode: DocMode }>
{
  query$ = new LiveData("");

  items$ = LiveData.computed((get) => {
    const query = get(this.query$);

    if (!query.trim()) {
      return [];
    }

    const items: QuickSearchItem<
      "creation",
      { title: string; mode: DocMode }
    >[] = [];
    const commands = new Map(
      MyoxusCommandRegistry.getAll().map((command) => [command.id, command]),
    );
    const pageCommand = commands.get("myoxus:new-page");
    if (
      pageCommand &&
      isCommandAvailable(pageCommand, { docMode: undefined })
    ) {
      items.push({
        id: "creation:create-page",
        source: "creation",
        label: {
          i18nKey: "com.myoxus.cmdk.create-new-page-as",
          options: { keyWord: query },
        },
        group,
        icon: NewXxxPageIcon,
        payload: { mode: "page", title: query },
      });
    }

    const edgelessCommand = commands.get("myoxus:new-edgeless-page");
    if (
      edgelessCommand &&
      isCommandAvailable(edgelessCommand, { docMode: undefined })
    ) {
      items.push({
        id: "creation:create-edgeless",
        source: "creation",
        label: {
          i18nKey: "com.myoxus.cmdk.create-new-edgeless-as",
          options: { keyWord: query },
        },
        group,
        icon: NewXxxEdgelessIcon,
        payload: { mode: "edgeless", title: query },
      });
    }
    return items;
  });

  query(query: string) {
    this.query$.next(query);
  }
}
