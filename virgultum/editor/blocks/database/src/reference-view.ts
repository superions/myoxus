// SPDX-License-Identifier: AGPL-3.0-or-later
//! Reference-only view registration for server-backed Database embeds.

import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";
import { BlockViewExtension, FlavourExtension } from "@virgultum/std";
import {
  SlashMenuConfigExtension,
  type SlashMenuItem,
} from "@virgultum/widget-slash-menu";
import { literal } from "lit/static-html.js";
import { z } from "zod";

import { DatabaseReferenceConfigExtension } from "./reference-config";
import { DatabaseReferenceBlockComponent } from "./reference-database-block";
import { DatabaseReferenceBlockModel } from "./reference-store";

export { DatabaseReferenceBlockComponent, DatabaseReferenceConfigExtension };

const optionsSchema = z.object({
  renderServerDatabase: z
    .function()
    .input([z.instanceof(DatabaseReferenceBlockModel)], z.unknown())
    .output(z.custom<unknown>()),
  slashMenuItems: z.custom<SlashMenuItem[]>().optional(),
});

export type DatabaseReferenceViewExtensionOptions = z.infer<
  typeof optionsSchema
>;

/**
 * Registers the persisted Database flavour without activating the historical
 * editor-local DataView renderer or its local creation actions.
 */
export class DatabaseReferenceViewExtension extends ViewExtensionProvider<DatabaseReferenceViewExtensionOptions> {
  override name = "myoxus-database-reference";

  override schema = optionsSchema;

  override effect() {
    super.effect();
    if (!customElements.get("myoxus-database-reference")) {
      customElements.define(
        "myoxus-database-reference",
        DatabaseReferenceBlockComponent,
      );
    }
  }

  override setup(
    context: ViewExtensionContext,
    options?: DatabaseReferenceViewExtensionOptions,
  ) {
    super.setup(context, options);
    context.register([
      FlavourExtension("myoxus:database"),
      BlockViewExtension("myoxus:database", literal`myoxus-database-reference`),
      SlashMenuConfigExtension("myoxus:database", {
        disableWhen: ({ model }) => model.flavour === "myoxus:database",
        items: options?.slashMenuItems ?? [],
      }),
    ]);
    if (options) context.register(DatabaseReferenceConfigExtension(options));
  }
}
