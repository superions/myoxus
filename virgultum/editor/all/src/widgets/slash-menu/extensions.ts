import { type Container } from "@virgultum/core/primitives/di";
import {
  type BlockStdScope,
  StdIdentifier,
  WidgetViewExtension,
} from "@virgultum/core/runtime";
import { Extension } from "@virgultum/core/store";
import {
  SlashMenuConfigExtension,
  SlashMenuConfigIdentifier,
} from "@virgultum/core/slash-menu";

import { defaultSlashMenuConfig } from "./config";
import { MYOXUS_SLASH_MENU_WIDGET } from "./consts";
import type { SlashMenuConfig } from "@virgultum/core/slash-menu";
import { mergeSlashMenuConfigs } from "./utils";

export class SlashMenuExtension extends Extension {
  config: SlashMenuConfig;

  static override setup(di: Container) {
    WidgetViewExtension(
      "myoxus:page",
      MYOXUS_SLASH_MENU_WIDGET,
      MYOXUS_SLASH_MENU_WIDGET,
    ).setup(di);

    di.add(this, [StdIdentifier]);

    SlashMenuConfigExtension("default", defaultSlashMenuConfig).setup(di);
  }

  constructor(readonly std: BlockStdScope) {
    super();
    this.config = mergeSlashMenuConfigs(
      this.std.provider.getAll(SlashMenuConfigIdentifier),
    );
  }
}

export { SlashMenuConfigExtension, SlashMenuConfigIdentifier };
