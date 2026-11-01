// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BlockModel } from "@virgultum/store";

const COMPOUND_MUTATION_BLOCK_FLAVOURS = new Set(["myoxus:mermaid"]);

export function requiresCompoundModelMutation(
  model: Pick<BlockModel, "flavour">,
) {
  return COMPOUND_MUTATION_BLOCK_FLAVOURS.has(model.flavour);
}

export function getCompoundMutationBlockedFlavours(models: BlockModel[]) {
  return [
    ...new Set(
      models
        .filter((model) => requiresCompoundModelMutation(model))
        .map((model) => model.flavour),
    ),
  ];
}
