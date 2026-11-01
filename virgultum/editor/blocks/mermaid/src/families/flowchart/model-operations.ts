// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidVisualEdgeLinkType,
  MermaidVisualModel,
  MermaidVisualSemanticStyle,
} from "../runtime/gfx-model.js";
import { resolveMermaidGfxTheme } from "../../mermaid-gfx-theme.js";
import { patchFlowchartInlineStyle } from "./text-formatting.js";

function cloneModel(model: MermaidVisualModel) {
  return JSON.parse(JSON.stringify(model)) as MermaidVisualModel;
}

export function setMermaidVisualNodeStyleClass(
  model: MermaidVisualModel,
  nodeId: string,
  className: MermaidVisualSemanticStyle | "",
) {
  const next = cloneModel(model);
  const statements: string[] = [];
  let insertionIndex: number | undefined;
  for (const statement of next.styleStatements ?? []) {
    const match =
      /^class\s+([A-Za-z0-9_,\s-]+?)\s+([A-Za-z0-9_-]+)\s*;?$/i.exec(statement);
    if (!match?.[1] || !match[2]) {
      statements.push(statement);
      continue;
    }
    const ids = match[1]
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (!ids.includes(nodeId)) {
      statements.push(statement);
      continue;
    }
    insertionIndex ??= statements.length;
    const remaining = ids.filter((id) => id !== nodeId);
    if (remaining.length) {
      statements.push(`class ${remaining.join(",")} ${match[2]};`);
      insertionIndex = statements.length;
    }
  }
  if (className) {
    const targetIndex = insertionIndex ?? statements.length;
    statements.splice(targetIndex, 0, `class ${nodeId} ${className};`);
    if (
      !statements.some((statement) =>
        new RegExp(`^classDef\\s+${className}(?:[,\\s]|$)`, "i").test(
          statement,
        ),
      )
    ) {
      const theme = resolveMermaidGfxTheme();
      const styles = {
        accent: [theme.secondarySurfaceColor, theme.primaryColor],
        error: [theme.errorSurfaceColor, theme.errorColor],
        neutral: [theme.surfaceColor, theme.secondaryTextColor],
        processing: [theme.processingSurfaceColor, theme.processingColor],
        success: [theme.successSurfaceColor, theme.successColor],
        warning: [theme.warningSurfaceColor, theme.warningColor],
      } satisfies Record<MermaidVisualSemanticStyle, readonly [string, string]>;
      const [fill, stroke] = styles[className];
      const definition = `classDef ${className} fill:${fill},stroke:${stroke},color:${theme.textColor};`;
      statements.splice(targetIndex, 0, definition);
    }
  }
  next.styleStatements = statements;
  return next;
}

export function setMermaidVisualEdgeStyleStatement(
  model: MermaidVisualModel,
  edgeId: string,
  styleName: MermaidVisualSemanticStyle | "",
) {
  const theme = resolveMermaidGfxTheme();
  const colors = {
    accent: theme.primaryColor,
    error: theme.errorColor,
    neutral: theme.secondaryTextColor,
    processing: theme.processingColor,
    success: theme.successColor,
    warning: theme.warningColor,
  } satisfies Record<MermaidVisualSemanticStyle, string>;
  return patchFlowchartInlineStyle(
    model,
    { kind: "edge", editKey: edgeId },
    {
      stroke: styleName ? colors[styleName] : null,
      "stroke-width": styleName ? "2px" : null,
    },
  );
}

export function setMermaidVisualEdgeStyle(
  model: MermaidVisualModel,
  edgeId: string,
  style: "dotted" | "solid" | "thick",
) {
  const next = cloneModel(model);
  const edge = next.edges.find((candidate) => candidate.id === edgeId);
  if (edge) {
    edge.style = style;
    edge.linkType =
      style === "dotted" ? "dotted" : style === "thick" ? "thick" : "arrow";
  }
  return next;
}

export function setMermaidVisualEdgeLinkType(
  model: MermaidVisualModel,
  edgeId: string,
  linkType: MermaidVisualEdgeLinkType,
) {
  const next = cloneModel(model);
  const edge = next.edges.find((candidate) => candidate.id === edgeId);
  if (edge) {
    edge.linkType = linkType;
    edge.sourceMarker = undefined;
    edge.targetMarker = undefined;
    edge.style =
      linkType === "dotted"
        ? "dotted"
        : linkType === "thick"
          ? "thick"
          : "solid";
  }
  return next;
}
