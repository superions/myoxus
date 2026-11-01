// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidBlockModel } from "@virgultum/model";

import { detectMermaidDiagramType } from "./engine/diagram-types.js";
import { resolveMermaidDiagramTitle } from "./engine/diagram-title.js";
import { isMermaidProductDiagramType } from "./engine/product-types.js";
import { getMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { mermaidMessages } from "./i18n.js";
import {
  coerceMermaidBlockText,
  getMermaidBlockSource,
  getMermaidBlockTitle,
  getMermaidDiagramTypeLabel,
  isMermaidAutomaticBlockTitle,
  setMermaidBlockText,
  type MermaidBlockSnapshotLike,
} from "./utils.js";

export function resolveMermaidEffectiveBlockTitle(
  props: MermaidBlockSnapshotLike,
) {
  const source = getMermaidBlockSource(props);
  const diagramType = detectMermaidDiagramType(source);
  const fallback = getMermaidBlockTitle(props);
  if (!isMermaidProductDiagramType(diagramType)) return fallback;
  const runtime = getMermaidFamilyRuntime(diagramType);
  const legacyTitle = isMermaidAutomaticBlockTitle(fallback)
    ? getMermaidDiagramTypeLabel(diagramType)
    : fallback;
  return resolveMermaidDiagramTitle({
    diagramType,
    familyTitle: runtime?.diagramTitle,
    legacyTitle,
    source,
  }).value;
}

export function reconcileMermaidTitleProjectionFromSource(
  model: MermaidBlockModel,
  previousSource?: string,
) {
  const source = getMermaidBlockSource(model.props);
  const diagramType = detectMermaidDiagramType(source);
  const storedTitle = getMermaidBlockTitle(model.props);
  let effectiveTitle = resolveMermaidEffectiveBlockTitle(model.props);
  if (
    previousSource !== undefined &&
    isMermaidProductDiagramType(diagramType)
  ) {
    const previousDiagramType = detectMermaidDiagramType(previousSource);
    const previousRuntime = isMermaidProductDiagramType(previousDiagramType)
      ? getMermaidFamilyRuntime(previousDiagramType)
      : undefined;
    const previousTitle = isMermaidProductDiagramType(previousDiagramType)
      ? resolveMermaidDiagramTitle({
          diagramType: previousDiagramType,
          familyTitle: previousRuntime?.diagramTitle,
          source: previousSource,
        })
      : null;
    const runtime = getMermaidFamilyRuntime(diagramType);
    const currentTitle = resolveMermaidDiagramTitle({
      diagramType,
      familyTitle: runtime?.diagramTitle,
      source,
    });
    if (
      (previousTitle?.kind === "native" ||
        previousTitle?.kind === "frontmatter") &&
      previousTitle.value === storedTitle &&
      currentTitle.kind === "none"
    )
      effectiveTitle = getMermaidDiagramTypeLabel(diagramType);
  }
  if (!effectiveTitle) return false;
  let changed = false;
  if (coerceMermaidBlockText(model.props.title) !== effectiveTitle) {
    setMermaidBlockText(model, "title", effectiveTitle);
    changed = true;
  }
  return changed;
}

export function getMermaidEffectiveBlockExportLabel(
  props: MermaidBlockSnapshotLike,
) {
  return mermaidMessages.exportLabel(resolveMermaidEffectiveBlockTitle(props));
}
