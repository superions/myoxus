import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { TableModelFlavour } from "@virgultum/model";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import { SlashMenuConfigExtension } from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";

import { tableSlashMenuConfig } from "./configs/slash-menu";
import { effects } from "./effects";

export class TableViewExtension extends ViewExtensionProvider {
  override name = "myoxus-table-block";

  override effect(): void {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register([
      FlavourExtension(TableModelFlavour),
      BlockViewExtension(TableModelFlavour, literal`myoxus-table`),
      SlashMenuConfigExtension(TableModelFlavour, tableSlashMenuConfig),
    ]);
  }
}
