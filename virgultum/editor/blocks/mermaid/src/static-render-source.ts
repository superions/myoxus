// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  projectMermaidViewSourceWithoutTitle,
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "./engine/diagram-title.js";
import { isMermaidProductDiagramType } from "./engine/product-types.js";
import { detectMermaidDiagramType } from "./families/runtime/gfx-host-contract.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";

/**
 * Mermaid's static renderer does not understand every family-native title
 * statement used by the first-class visual editors. Compile the effective
 * title to Mermaid frontmatter for rendering without mutating stored source or
 * dropping the title from SVG/PNG output.
 */
export function projectMermaidExportRenderSource(
  source: string,
  legacyTitle = "",
) {
  const diagramType = detectMermaidDiagramType(source);
  if (!isMermaidProductDiagramType(diagramType)) return source;

  const runtime = getMermaidFamilyRuntime(diagramType);
  const effectiveTitle = resolveMermaidDiagramTitle({
    diagramType,
    familyTitle: runtime?.diagramTitle,
    legacyTitle,
    source,
  });
  if (!effectiveTitle.value) return source;

  const withoutTitle = projectMermaidViewSourceWithoutTitle(
    source,
    effectiveTitle,
  );
  return (
    writeMermaidDiagramTitle({
      diagramType,
      source: withoutTitle,
      title: effectiveTitle.value,
    }) ?? source
  );
}
