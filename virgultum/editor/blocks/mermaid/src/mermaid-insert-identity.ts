// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_MERMAID_BLOCK_TITLE } from "@virgultum/model";

import {
  resolveMermaidDiagramTitle,
  writeMermaidDiagramTitle,
} from "./engine/diagram-title.js";
import { isMermaidProductDiagramType } from "./engine/product-types.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { mermaidMessages } from "./i18n.js";
import { parseMermaidSourceToGfxVisualModel } from "./mermaid-gfx-graph-adapters.js";
import { getMermaidDiagramTypeLabel } from "./utils.js";

export function resolveMermaidBlockInsertIdentity({
  source,
  title,
}: {
  readonly source: string;
  readonly title?: string;
}) {
  const parsed = parseMermaidSourceToGfxVisualModel(source);
  if (!isMermaidProductDiagramType(parsed.diagramType)) {
    return { source, title: title?.trim() || mermaidMessages.defaultTitle() };
  }
  const runtime = getMermaidFamilyRuntime(parsed.diagramType);
  const candidateTitle = title?.trim() ?? "";
  const explicitTitle =
    candidateTitle === DEFAULT_MERMAID_BLOCK_TITLE ||
    candidateTitle === mermaidMessages.defaultTitle()
      ? ""
      : candidateTitle;
  const fallbackTitle =
    explicitTitle || getMermaidDiagramTypeLabel(parsed.diagramType);
  const resolved = resolveMermaidDiagramTitle({
    diagramType: parsed.diagramType,
    familyTitle: runtime?.diagramTitle,
    legacyTitle: fallbackTitle,
    source,
  });
  const nextSource =
    resolved.kind === "legacy"
      ? (writeMermaidDiagramTitle({
          diagramType: parsed.diagramType,
          familyTitle: runtime?.diagramTitle,
          source,
          title: resolved.value,
        }) ?? source)
      : source;
  const effective = resolveMermaidDiagramTitle({
    diagramType: parsed.diagramType,
    familyTitle: runtime?.diagramTitle,
    legacyTitle: fallbackTitle,
    source: nextSource,
  });
  return { source: nextSource, title: effective.value };
}
