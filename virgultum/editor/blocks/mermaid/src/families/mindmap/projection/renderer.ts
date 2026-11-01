// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapDesign as MindmapStyle } from "./types.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualEdge,
} from "../../runtime/gfx-model.js";
import type {
  MermaidGfxNodeElementProjection,
  MermaidGfxConnectorElementProjection,
} from "../../runtime/gfx-family-hooks-contract.js";
import {
  mermaidVisualFamilyPayload,
  type MermaidGfxJsonObject,
} from "../../runtime/gfx-family-data.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import { mindmapNodeDesign, mindmapBranchDesign } from "./designs.js";
import { isMindmapShape } from "../../../engine/mindmap/index.js";
import { mindmapIconResource } from "./decorations.js";

import { resolveMermaidGfxProjectionTheme } from "../../../mermaid-gfx-theme.js";
import {
  projectNeutralMermaidGfxNodeElement,
  projectNeutralMermaidGfxConnectorElement,
} from "../../runtime/gfx-element-projection-defaults.js";

/** Measurement and native shape painting share the same resolved font. A
 * source-derived label never enters the generic fit/shrink heuristic. */
export function mindmapNodeProjection(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
): MermaidGfxNodeElementProjection {
  const base = projectNeutralMermaidGfxNodeElement(node);
  const raw = mermaidVisualFamilyPayload(
    node.familyData,
    "mindmap",
  )?.presentation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const presentation = raw as MermaidGfxJsonObject;
  const fontValue = presentation.typography,
    padding = presentation.padding;
  if (!fontValue || typeof fontValue !== "object" || Array.isArray(fontValue))
    return base;
  const font = fontValue as MermaidGfxJsonObject;
  if (
    typeof font.fontSize !== "number" ||
    !Number.isFinite(font.fontSize) ||
    font.fontSize <= 0 ||
    typeof font.fontFamily !== "string" ||
    typeof font.fontStyle !== "string" ||
    typeof font.fontWeight !== "string"
  )
    return base;
  const options = readMindmapProjectionOptions(model);
  const data = mermaidVisualFamilyPayload(node.familyData, "mindmap")!;
  const path = Array.isArray(presentation.path)
    ? presentation.path.filter(
        (value): value is number =>
          typeof value === "number" && Number.isInteger(value) && value >= 0,
      )
    : [0];
  const design = mindmapNodeDesign(
    options.design ?? MindmapStyle.ONE,
    path,
    data.parentKey === null,
    isMindmapShape(data.shape) ? data.shape : "default",
    resolveMermaidGfxProjectionTheme(),
    options.nodeAppearance?.get(node.id),
  );
  const runs = Array.isArray(presentation.runs)
    ? presentation.runs.flatMap((run) => {
        if (!run || typeof run !== "object" || Array.isArray(run)) return [];
        const value = run as MermaidGfxJsonObject;
        return typeof value.text === "string" &&
          typeof value.bold === "boolean" &&
          typeof value.italic === "boolean"
          ? [{ text: value.text, bold: value.bold, italic: value.italic }]
          : [];
      })
    : [];
  const rawBox = presentation.textBox;
  const box =
    rawBox && typeof rawBox === "object" && !Array.isArray(rawBox)
      ? (rawBox as MermaidGfxJsonObject)
      : undefined;
  const icon = mindmapIconResource(
    typeof data.icon === "string" ? data.icon : undefined,
  );
  const iconSize =
    typeof presentation.iconSize === "number" ? presentation.iconSize : 0;
  const labelProjection =
    box &&
    [box.x, box.y, box.width, box.height, font.lineHeight].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    )
      ? {
          runs,
          box: {
            x: box.x as number,
            y: box.y as number,
            width: box.width as number,
            height: box.height as number,
          },
          lineHeight: font.lineHeight as number,
          ...(icon && iconSize
            ? {
                icon: {
                  ...icon,
                  x: (box.x as number) - iconSize - iconSize / 4,
                  y: (node.height - iconSize) / 2,
                  size: iconSize,
                },
              }
            : {}),
        }
      : null;
  return {
    ...base,
    ...design,
    labelProjection,
    textDisplay: Boolean(icon) || Boolean(node.displayLabel),
    text: node.displayLabel ?? node.label,
    fontSize: font.fontSize,
    fontFamily: font.fontFamily,
    fontStyle: font.fontStyle,
    fontWeight: font.fontWeight,
    padding:
      Array.isArray(padding) &&
      typeof padding[0] === "number" &&
      typeof padding[1] === "number" &&
      padding
        .slice(0, 2)
        .every(
          (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0,
        )
        ? [padding[0], padding[1]]
        : undefined,
  };
}

export function mindmapBranchProjection(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
): MermaidGfxConnectorElementProjection {
  const raw = mermaidVisualFamilyPayload(edge.familyData, "mindmap");
  const data =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as MermaidGfxJsonObject)
      : undefined;
  const path = Array.isArray(data?.path)
    ? data.path.filter((value): value is number => typeof value === "number")
    : [0, 0];
  const options = readMindmapProjectionOptions(model);
  return {
    ...projectNeutralMermaidGfxConnectorElement(edge),
    ...mindmapBranchDesign(
      options.design ?? MindmapStyle.ONE,
      path,
      resolveMermaidGfxProjectionTheme(),
      options.branchAppearance?.get(edge.target),
    ),
  };
}
