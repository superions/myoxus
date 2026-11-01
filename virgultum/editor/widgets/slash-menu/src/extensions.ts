import { type Container, createIdentifier } from "@virgultum/global/di";
import {
  type BlockStdScope,
  StdIdentifier,
  WidgetViewExtension,
} from "@virgultum/std";
import { Extension, type ExtensionType } from "@virgultum/store";
import { literal, unsafeStatic } from "lit/static-html.js";

import { defaultSlashMenuConfig } from "./config";
import { MYOXUS_SLASH_MENU_WIDGET } from "./consts";
import type { SlashMenuConfig } from "./types";
import { mergeSlashMenuConfigs } from "./utils";

export class SlashMenuExtension extends Extension {
  config: SlashMenuConfig;

  static override setup(di: Container) {
    WidgetViewExtension(
      "myoxus:page",
      MYOXUS_SLASH_MENU_WIDGET,
      literal`${unsafeStatic(MYOXUS_SLASH_MENU_WIDGET)}`,
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

export const SlashMenuConfigIdentifier = createIdentifier<SlashMenuConfig>(
  `${MYOXUS_SLASH_MENU_WIDGET}-config`,
);

export function SlashMenuConfigExtension(
  id: string,
  config: SlashMenuConfig,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(SlashMenuConfigIdentifier(id), config);
    },
  };
}
