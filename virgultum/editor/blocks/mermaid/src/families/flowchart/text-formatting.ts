// SPDX-License-Identifier: AGPL-3.0-or-later

import { resolveMermaidGfxTheme } from "../../mermaid-gfx-theme.js";
import type { MermaidPageSelectionItem } from "../runtime/contracts.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import {
  flowchartEdgeElementStyle,
  flowchartNodeElementStyle,
  flowchartStyleTargetIds,
  flowchartSubgraphElementStyle,
  parseFlowchartStyleDeclaration,
} from "./gfx-style-projection.js";

export type FlowchartTextFormat = {
  readonly fontSize: number | null;
  readonly bold: boolean | null;
  readonly italic: boolean | null;
};
export type FlowchartTextFormatPatch = Partial<{
  fontSize: number;
  bold: boolean;
  italic: boolean;
}>;
type Target = Pick<MermaidPageSelectionItem, "kind" | "editKey">;

export function readFlowchartTextFormat(
  model: MermaidVisualModel,
  targets: readonly Target[],
): FlowchartTextFormat | null {
  const theme = resolveMermaidGfxTheme();
  const values = targets.flatMap((target) => {
    const element =
      target.kind === "node"
        ? model.nodes.find((node) => node.id === target.editKey)
        : target.kind === "subgraph"
          ? model.subgraphs?.find((group) => group.id === target.editKey)
          : undefined;
    const edgeIndex = model.edges.findIndex(
      (edge) => edge.id === target.editKey,
    );
    const style =
      target.kind === "edge" && edgeIndex >= 0
        ? flowchartEdgeElementStyle(model, model.edges[edgeIndex]!, edgeIndex)
        : target.kind === "node" && element
          ? flowchartNodeElementStyle(
              model,
              element as (typeof model.nodes)[number],
            )
          : target.kind === "subgraph" && element
            ? flowchartSubgraphElementStyle(
                model,
                element as NonNullable<typeof model.subgraphs>[number],
              )
            : null;
    return style
      ? [
          {
            fontSize: style.fontSize ?? theme.typography.fontSize,
            bold:
              ["bold", "semibold"].includes(
                String(
                  style.fontWeight ?? theme.typography.fontWeight,
                ).toLowerCase(),
              ) ||
              Number(style.fontWeight ?? theme.typography.fontWeight) >= 600,
            italic:
              (style.fontStyle ?? theme.typography.fontStyle) === "italic",
          },
        ]
      : [];
  });
  if (!values.length) return null;
  const common = <K extends keyof FlowchartTextFormat>(
    key: K,
  ): FlowchartTextFormat[K] =>
    values.every((value) => value[key] === values[0]![key])
      ? values[0]![key]
      : null;
  return {
    fontSize: common("fontSize"),
    bold: common("bold"),
    italic: common("italic"),
  };
}

/** Split shared declarations before changing one target. Class definitions and
 * unrelated inline properties remain Source-owned; no GFX-only font override. */
export function patchFlowchartInlineStyle(
  model: MermaidVisualModel,
  target: Target,
  patch: Readonly<Record<string, string | null>>,
) {
  const edgeIndex = model.edges.findIndex((edge) => edge.id === target.editKey);
  const key = target.kind === "edge" ? String(edgeIndex) : target.editKey;
  if (target.kind === "edge" && edgeIndex < 0) return model;
  const command = target.kind === "edge" ? "linkStyle" : "style";
  const statements: string[] = [];
  const keys = new Set(Object.keys(patch));
  for (const statement of model.styleStatements ?? []) {
    const match = /^(style|linkStyle)\s+(.+?)\s+([\w-]+\s*:.+)$/iu.exec(
      statement,
    );
    const ids = match?.[2] ? flowchartStyleTargetIds(match[2]) : [];
    if (
      match?.[1]?.toLowerCase() !== command ||
      !ids.includes(key) ||
      !match[3]
    ) {
      statements.push(statement);
      continue;
    }
    const properties = parseFlowchartStyleDeclaration(match[3]);
    if (!Object.keys(properties).some((property) => keys.has(property))) {
      statements.push(statement);
      continue;
    }
    const remaining = ids.filter((id) => id !== key);
    if (remaining.length)
      statements.push(`${command} ${remaining.join(",")} ${match[3]}`);
    // Keep untouched properties at their original cascade position. Moving
    // fill/stroke or inherited font fields past a class would change them.
    const untouched = Object.entries(properties)
      .filter(([property]) => !keys.has(property))
      .map(([property, value]) => `${property}:${value}`)
      .join(",");
    if (untouched) statements.push(`${command} ${key} ${untouched};`);
  }
  const declaration = Object.entries(patch)
    .filter(([, value]) => value !== null)
    .map(([property, value]) => `${property}:${value}`)
    .join(",");
  if (declaration) statements.push(`${command} ${key} ${declaration};`);
  return { ...model, styleStatements: statements };
}

export function setFlowchartTextFormat(
  model: MermaidVisualModel,
  targets: readonly Target[],
  patch: FlowchartTextFormatPatch,
) {
  const properties: Record<string, string> = {};
  if (
    patch.fontSize !== undefined &&
    Number.isFinite(patch.fontSize) &&
    patch.fontSize >= 1
  )
    properties["font-size"] = `${patch.fontSize}px`;
  if (patch.bold !== undefined)
    properties["font-weight"] = patch.bold ? "700" : "400";
  if (patch.italic !== undefined)
    properties["font-style"] = patch.italic ? "italic" : "normal";
  return targets.reduce(
    (next, target) => patchFlowchartInlineStyle(next, target, properties),
    model,
  );
}
