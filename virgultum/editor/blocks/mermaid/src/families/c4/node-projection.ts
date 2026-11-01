// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidC4Element } from "../../engine/c4/model.js";
import type { MermaidC4Config } from "../../engine/c4/runtime-contract.js";
import type { C4SourceDocument } from "../../engine/c4/source-document.js";
import { visualNode } from "../gfx-visual-model-helpers.js";
import { c4NodeFamilyData } from "./object-data.js";
import { c4ElementVisualShape } from "./element-projection.js";
import {
  projectC4MaterializedNode,
  sizeC4ContentNode,
} from "./content-projection.js";
import { c4NativeSourceStyles } from "./style-projection.js";

/** Native 11.17.2 geometry defaults, never an app theme or color fallback. */
export function c4ContentGeometry(config: MermaidC4Config) {
  return {
    width: Math.max(1, config.width ?? 216),
    padding: Math.max(0, config.c4ShapePadding ?? 20),
  };
}

/** Packing and every GFX consumer measure this same semantic body. Metadata
 * never contributes text, width or height; layout cannot estimate by spelling. */
export function projectC4ElementNode(
  element: MermaidC4Element,
  config: MermaidC4Config,
  document: C4SourceDocument,
) {
  const geometry = c4ContentGeometry(config),
    fields = element.resolution!.fields;
  const effectiveTechnology =
    typeof fields.techn === "string" ? fields.techn : element.technology;
  const effectiveSprite =
    typeof fields.sprite === "string" ? fields.sprite : element.sprite;
  const shape = c4ElementVisualShape({ ...element, sprite: effectiveSprite });
  return sizeC4ContentNode(
    projectC4MaterializedNode(
      visualNode({
        familyData: c4NodeFamilyData({
          styles: c4NativeSourceStyles(element, config),
          contentPadding: geometry.padding,
          description: element.description,
          effectiveSprite,
          effectiveTechnology,
          link: element.link,
          kind: element.kind,
          sourceTechnology: element.technology,
          sprite: element.sprite,
          spriteOverridden: document.records.some(
            (r) =>
              r.callKind === "UpdateElementStyle" &&
              r.sourceKey === element.resolution!.providers.sprite?.sourceKey,
          ),
          tags: element.tags,
        }),
        height: 1,
        id: element.resolution!.selectionId,
        label: element.label,
        shape,
        // Native unified Person has a technical minimum body width of 100.
        width:
          shape === "person" ? Math.max(100, geometry.width) : geometry.width,
        x: element.x,
        y: element.y,
      }),
    ),
  );
}
