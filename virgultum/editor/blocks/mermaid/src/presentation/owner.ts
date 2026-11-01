// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BlockModel } from "@virgultum/store";

import type {
  MermaidFamilyResolvedRuntimeResolution,
  MermaidFamilyRuntimeResolution,
} from "../families/runtime/contracts.js";
import type { MermaidBlockModel } from "@virgultum/model";
import type { MermaidEditorCapabilities } from "../families/runtime/editor-capabilities.js";
import { resolveMermaidFamilyRuntime } from "../families/runtime/registry.js";

export type MermaidOwnerPresentation = "embedded" | "native-edgeless";

export function isMermaidBlockModel(
  model: unknown,
): model is MermaidBlockModel {
  return Boolean(
    model &&
    typeof model === "object" &&
    "flavour" in model &&
    model.flavour === "myoxus:mermaid",
  );
}

export function canProjectMermaidNatively(
  resolution: MermaidFamilyRuntimeResolution,
): resolution is MermaidFamilyResolvedRuntimeResolution & {
  readonly capabilities: MermaidEditorCapabilities & { readonly kind: "gfx" };
} {
  return (
    resolution.kind === "resolved" && resolution.capabilities.kind === "gfx"
  );
}

export function canMutateMermaidGfxOwnerSource({
  lastValidSource = "",
  parent,
  source,
}: {
  readonly lastValidSource?: string;
  readonly parent: Pick<BlockModel, "flavour"> | null;
  readonly source: string;
}) {
  const current = resolveMermaidFamilyRuntime(source);
  if (!canProjectMermaidNatively(current)) return false;
  if (parent?.flavour !== "myoxus:surface" || !lastValidSource) return true;
  const retained = resolveMermaidFamilyRuntime(lastValidSource);
  return (
    canProjectMermaidNatively(retained) &&
    retained.diagramType === current.diagramType
  );
}

export function resolveMermaidOwnerPresentation({
  lastValidSource = "",
  parent,
  source,
}: {
  readonly lastValidSource?: string;
  readonly parent: Pick<BlockModel, "flavour"> | null;
  readonly source: string;
}): MermaidOwnerPresentation {
  if (parent?.flavour !== "myoxus:surface") return "embedded";

  const currentResolution = resolveMermaidFamilyRuntime(source);
  if (canProjectMermaidNatively(currentResolution)) return "native-edgeless";

  const lastValidResolution = lastValidSource
    ? resolveMermaidFamilyRuntime(lastValidSource)
    : null;
  return lastValidResolution && canProjectMermaidNatively(lastValidResolution)
    ? "native-edgeless"
    : "embedded";
}
