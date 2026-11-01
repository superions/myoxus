// SPDX-License-Identifier: AGPL-3.0-or-later
import { detectMermaidDiagramType } from "../engine/diagram-types.js";
import { getMermaidGfxFamilyHooksForDiagramType } from "../families/runtime/gfx-family-hooks-registry.js";

/** Shared by Page clipboard, native clipboard and the normal duplicate command.
 * Families own their binding schema; unrelated metadata is retained unchanged. */
export function prepareMermaidOwnerCopy(
  source: string,
  familyData: string,
  comments?: Record<string, boolean>,
) {
  const hook = getMermaidGfxFamilyHooksForDiagramType(
    detectMermaidDiagramType(source),
  )?.remapCopiedIdentities;
  const remap = hook?.(source, familyData);
  if (hook && !remap) return null;
  return {
    familyData: remap?.familyData ?? familyData,
    remapElement: remap?.remapElement ?? (() => ({})),
    comments:
      comments &&
      Object.fromEntries(
        Object.entries(comments).map(([key, value]) => [
          remap?.identityMap.get(key) ?? key,
          value,
        ]),
      ),
  };
}
