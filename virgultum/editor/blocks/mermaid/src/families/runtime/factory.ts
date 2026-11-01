// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidProductDiagramType } from "../../engine/product-types.js";
import type { MermaidVisualModel } from "./gfx-model.js";
import type { MermaidFamilyRuntime } from "./contracts.js";

export function defineMermaidFamilyRuntime<
  const TFamily extends MermaidFamilyRuntime,
>(runtime: TFamily): TFamily {
  return runtime;
}

export function resolveEditableMermaidFamilyModel<TParsed, TVisualModel>(
  family: {
    readonly parseSource: (
      source: string,
      diagramType: MermaidProductDiagramType,
    ) => TParsed;
    readonly toVisualModel: (
      parsed: TParsed,
    ) =>
      | { readonly kind: "editable"; readonly visualModel: TVisualModel }
      | { readonly kind: "source-only" | "unsupported" };
  },
  source: string,
  diagramType: MermaidProductDiagramType,
): TVisualModel | null {
  const state = family.toVisualModel(family.parseSource(source, diagramType));
  return state.kind === "editable" ? state.visualModel : null;
}

export type MermaidFamilyVisualModelResolver = (
  source: string,
  diagramType: MermaidProductDiagramType,
) => MermaidVisualModel | null;

/** A shared runtime can retain Source bytes for an individual owned type. */
export function mermaidRuntimePreservesSourceBytes(
  runtime: MermaidFamilyRuntime | null | undefined,
  diagramType: string,
) {
  const policy = runtime?.preserveSourceBytes;
  return typeof policy === "function" ? policy(diagramType) : Boolean(policy);
}
