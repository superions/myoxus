// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  FontStyle,
  FontWeight,
  LineWidth,
  StrokeStyle,
} from "@virgultum/model";
import { Bound } from "@virgultum/global/gfx";

import {
  mermaidGfxThemeProperties,
  mermaidGfxLabelPadding,
  resolveMermaidGfxProjectionTheme,
  resolveMermaidGfxTheme,
  type MermaidGfxTheme,
} from "../../mermaid-gfx-theme.js";
import {
  flowchartLabelTypography,
  projectFlowchartNodeLabel,
} from "./label-geometry.js";
import { flowchartConnectorRoutingMatches } from "./connection-projection.js";

import type {
  MermaidVisualEdge,
  MermaidVisualModel,
  MermaidVisualNode,
  MermaidVisualSemanticStyle,
  MermaidVisualSubgraph,
} from "../runtime/gfx-model.js";

type FlowchartSemanticTheme = Pick<
  MermaidGfxTheme,
  | "borderColor"
  | "errorColor"
  | "errorSurfaceColor"
  | "primaryColor"
  | "processingColor"
  | "processingSurfaceColor"
  | "secondarySurfaceColor"
  | "secondaryTextColor"
  | "successColor"
  | "successSurfaceColor"
  | "surfaceColor"
  | "textColor"
  | "warningColor"
  | "warningSurfaceColor"
>;

function flowchartNodeSemanticStyles(theme: FlowchartSemanticTheme) {
  return {
    accent: {
      color: theme.textColor,
      fill: theme.secondarySurfaceColor,
      stroke: theme.primaryColor,
    },
    error: {
      color: theme.textColor,
      fill: theme.errorSurfaceColor,
      stroke: theme.errorColor,
    },
    neutral: {
      color: theme.textColor,
      fill: theme.surfaceColor,
      stroke: theme.secondaryTextColor,
    },
    processing: {
      color: theme.textColor,
      fill: theme.processingSurfaceColor,
      stroke: theme.processingColor,
    },
    success: {
      color: theme.textColor,
      fill: theme.successSurfaceColor,
      stroke: theme.successColor,
    },
    warning: {
      color: theme.textColor,
      fill: theme.warningSurfaceColor,
      stroke: theme.warningColor,
    },
  } as const;
}

function flowchartEdgeSemanticStyles(theme: FlowchartSemanticTheme) {
  return {
    accent: theme.primaryColor,
    error: theme.errorColor,
    neutral: theme.secondaryTextColor,
    processing: theme.processingColor,
    success: theme.successColor,
    warning: theme.warningColor,
  } as const;
}

export function flowchartSemanticStylePreviews() {
  const colorReference = (property: string) => `var(${property})`;
  const theme = {
    borderColor: colorReference(mermaidGfxThemeProperties.borderColor),
    errorColor: colorReference(mermaidGfxThemeProperties.errorColor),
    errorSurfaceColor: colorReference(
      mermaidGfxThemeProperties.errorSurfaceColor,
    ),
    primaryColor: colorReference(mermaidGfxThemeProperties.primaryColor),
    processingColor: colorReference(mermaidGfxThemeProperties.processingColor),
    processingSurfaceColor: colorReference(
      mermaidGfxThemeProperties.processingSurfaceColor,
    ),
    secondarySurfaceColor: colorReference(
      mermaidGfxThemeProperties.secondarySurfaceColor,
    ),
    secondaryTextColor: colorReference(
      mermaidGfxThemeProperties.secondaryTextColor,
    ),
    successColor: colorReference(mermaidGfxThemeProperties.successColor),
    successSurfaceColor: colorReference(
      mermaidGfxThemeProperties.successSurfaceColor,
    ),
    surfaceColor: colorReference(mermaidGfxThemeProperties.surfaceColor),
    textColor: colorReference(mermaidGfxThemeProperties.textColor),
    warningColor: colorReference(mermaidGfxThemeProperties.warningColor),
    warningSurfaceColor: colorReference(
      mermaidGfxThemeProperties.warningSurfaceColor,
    ),
  } satisfies FlowchartSemanticTheme;
  const nodeStyles = flowchartNodeSemanticStyles(theme);
  const edgeStyles = flowchartEdgeSemanticStyles(theme);
  const preview = (style: MermaidVisualSemanticStyle | "") => {
    const nodeStyle = style
      ? nodeStyles[style]
      : {
          color: theme.textColor,
          fill: theme.surfaceColor,
          stroke: theme.borderColor,
        };
    return {
      backgroundColor: nodeStyle.fill,
      edgeColor: style ? edgeStyles[style] : theme.borderColor,
      foregroundColor: nodeStyle.color,
      outlineColor: nodeStyle.stroke,
    };
  };
  return {
    "": preview(""),
    accent: preview("accent"),
    error: preview("error"),
    neutral: preview("neutral"),
    processing: preview("processing"),
    success: preview("success"),
    warning: preview("warning"),
  } as const;
}

export function parseFlowchartStyleDeclaration(input: string) {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let escaped = false;
  let quote: '"' | "'" | null = null;
  for (const character of input.replace(/;$/, "")) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && !quote) {
      quote = character;
    } else if (character === quote) {
      quote = null;
    } else if (!quote && character === "(") {
      depth += 1;
    } else if (!quote && character === ")") {
      depth = Math.max(0, depth - 1);
    }
    if (!quote && depth === 0 && character === ",") {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, part) => {
      const separator = part.indexOf(":");
      if (separator <= 0) return result;
      const key = part.slice(0, separator).trim().toLowerCase();
      const value = part.slice(separator + 1).trim();
      if (key && value) result[key] = value;
      return result;
    }, {});
}

export function flowchartStyleTargetIds(value: string) {
  const targets: string[] = [];
  let quote = "";
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];
    if (
      (character === '"' || character === "`") &&
      (!quote || quote === character)
    ) {
      quote = quote ? "" : character;
    }
    if (index < value.length && (character !== "," || quote)) continue;
    const target = value
      .slice(start, index)
      .trim()
      .replace(/^(?:"([\s\S]*)"|`([\s\S]*)`)$/, "$1$2");
    if (target) targets.push(target);
    start = index + 1;
  }
  return targets;
}

function nodeClassStatement(statement: string) {
  const match = /^(class|cssClass)\s+(.+?)\s+([^\s;]+)\s*;?$/iu.exec(statement);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    classNames: match[3].split(",").map((name) => name.trim()),
    nodeIds: flowchartStyleTargetIds(
      match[1].toLowerCase() === "cssclass"
        ? match[2].replace(/^"([\s\S]*)"$/, "$1")
        : match[2],
    ),
  };
}

function resolveFlowchartNodeStyle(
  model: MermaidVisualModel,
  target: { readonly id: string },
) {
  const classDefs = new Map<string, Record<string, string>>();
  const declarations: Record<string, string>[] = [];
  for (const statement of model.styleStatements ?? []) {
    const classDef = /^classDef\s+([^\s]+)\s+(.+)$/iu.exec(statement);
    if (!classDef?.[1] || !classDef[2]) continue;
    for (const className of classDef[1].split(",")) {
      if (className.trim()) {
        classDefs.set(
          className.trim(),
          parseFlowchartStyleDeclaration(classDef[2]),
        );
      }
    }
  }
  const defaultDeclaration = classDefs.get("default");
  if (defaultDeclaration) declarations.push(defaultDeclaration);
  for (const statement of model.styleStatements ?? []) {
    const classStatement = nodeClassStatement(statement);
    if (classStatement?.nodeIds.includes(target.id)) {
      for (const className of classStatement.classNames) {
        const declaration = classDefs.get(className);
        if (declaration) declarations.push(declaration);
      }
      continue;
    }
    const styleStatement = /^style\s+(.+?)\s+([\w-]+\s*:.+)$/iu.exec(statement);
    if (
      styleStatement?.[1] &&
      flowchartStyleTargetIds(styleStatement[1]).includes(target.id) &&
      styleStatement[2]
    ) {
      declarations.push(parseFlowchartStyleDeclaration(styleStatement[2]));
    }
  }
  return Object.assign({}, ...declarations) as Record<string, string>;
}

function stylePixelNumber(value: string | undefined) {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  return match ? Number(match[1]) : null;
}

function styleFontWeight(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "bold" || Number(normalized) >= 700)
    return FontWeight.Bold;
  if (Number(normalized) >= 600) return FontWeight.SemiBold;
  if (Number(normalized) >= 500) return FontWeight.Medium;
  if (normalized === "lighter" || Number(normalized) <= 300) {
    return FontWeight.Light;
  }
  return FontWeight.Regular;
}

function flowchartElementStyle(
  model: MermaidVisualModel,
  target: { readonly id: string },
) {
  const style = resolveFlowchartNodeStyle(model, target);
  const theme = resolveMermaidGfxProjectionTheme();
  const strokeWidth = stylePixelNumber(style["stroke-width"]);
  const fillHidden = /^(?:none|transparent)$/i.test(style.fill ?? "");
  const strokeHidden =
    /^(?:none|transparent)$/i.test(style.stroke ?? "") || strokeWidth === 0;
  const strokeDashed = Boolean(
    style["stroke-dasharray"] &&
    !/^(?:0|none)$/i.test(style["stroke-dasharray"]),
  );
  const fontSize = stylePixelNumber(style["font-size"]);
  const fontWeight = styleFontWeight(style["font-weight"]);
  return {
    ...(style.color ? { color: style.color } : {}),
    ...(style.fill
      ? { fillColor: fillHidden ? theme.surfaceColor : style.fill }
      : {}),
    ...(fontSize !== null ? { fontSize } : {}),
    ...(style["font-style"]
      ? {
          fontStyle:
            style["font-style"].trim().toLowerCase() === "italic"
              ? FontStyle.Italic
              : FontStyle.Normal,
        }
      : {}),
    ...(fontWeight ? { fontWeight } : {}),
    ...(style.fill ? { filled: !fillHidden } : {}),
    ...(style.stroke
      ? { strokeColor: strokeHidden ? theme.borderColor : style.stroke }
      : {}),
    ...(style.stroke || style["stroke-dasharray"] || strokeWidth !== null
      ? {
          strokeStyle: strokeHidden
            ? StrokeStyle.None
            : strokeDashed
              ? StrokeStyle.Dash
              : StrokeStyle.Solid,
        }
      : {}),
    ...(strokeWidth !== null
      ? {
          strokeWidth: Math.min(
            LineWidth.Twelve,
            Math.max(LineWidth.Two, strokeWidth),
          ),
        }
      : {}),
  };
}

function resolveFlowchartEdgeStyle(
  model: MermaidVisualModel,
  edgeIndex: number,
) {
  const result: Record<string, string> = {};
  for (const statement of model.styleStatements ?? []) {
    const match = /^linkStyle\s+(default|[0-9,\s]+)\s+(.+)$/i.exec(statement);
    if (
      (match?.[1] === "default" ||
        match?.[1]
          ?.split(",")
          .map((value) => Number(value.trim()))
          .includes(edgeIndex)) &&
      match?.[2]
    ) {
      Object.assign(result, parseFlowchartStyleDeclaration(match[2]));
    }
  }
  return result;
}

export function flowchartMinimumReadableZoom(
  model: MermaidVisualModel,
  sharedMinimum: number,
) {
  const theme = resolveMermaidGfxTheme();
  const visibleFontSizes = [
    ...model.nodes.map(
      (node) => flowchartNodeElementStyle(model, node).fontSize,
    ),
    ...(model.subgraphs ?? []).map(
      (subgraph) => flowchartSubgraphElementStyle(model, subgraph).fontSize,
    ),
    ...model.edges.flatMap((edge, edgeIndex) =>
      edge.label
        ? [flowchartEdgeElementStyle(model, edge, edgeIndex).fontSize]
        : [],
    ),
  ].filter((fontSize): fontSize is number => fontSize !== undefined);
  const smallestVisibleFontSize =
    visibleFontSizes.length > 0
      ? Math.min(...visibleFontSizes)
      : flowchartDefaultLabelFontSize(theme);
  const typographyOwnedMinimum =
    theme.typography.minimumReadableFontSize / smallestVisibleFontSize;
  // A larger projected label must not lower the viewport floor and shrink the
  // entire diagram in compensation. Anchor normal Flowchart camera scale to a
  // stable body-derived label baseline; explicit smaller Mermaid font sizes
  // can still raise the readability floor through typographyOwnedMinimum.
  const stableProjectionMinimum =
    theme.typography.minimumReadableFontSize /
    (theme.typography.fontSize +
      (theme.typography.lineHeight - theme.typography.fontSize) / 2);
  return Math.max(
    sharedMinimum,
    typographyOwnedMinimum,
    stableProjectionMinimum,
  );
}

const FLOWCHART_MANAGED_APPEARANCE_KEYS = [
  "color",
  "fillColor",
  "filled",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "padding",
  "labelProjection",
  "strokeColor",
  "strokeStyle",
  "strokeWidth",
] as const;

function flowchartManagedAppearanceMatches(
  actual: unknown,
  expected: Readonly<Record<string, unknown>>,
) {
  if (!actual || typeof actual !== "object") return false;
  const element = actual as Record<string, unknown>;
  return FLOWCHART_MANAGED_APPEARANCE_KEYS.every((key) => {
    const actualValue = element[key];
    const expectedValue = expected[key];
    return (actualValue !== null && typeof actualValue === "object") ||
      (expectedValue !== null && typeof expectedValue === "object")
      ? JSON.stringify(actualValue) === JSON.stringify(expectedValue)
      : actualValue === expectedValue;
  });
}

export function flowchartProjectionOwnerAppearanceMatchesTheme(
  model: MermaidVisualModel,
  elements: readonly unknown[],
  connectors: readonly unknown[] = [],
) {
  const theme = resolveMermaidGfxProjectionTheme();
  const neutralAppearance = {
    color: theme.textColor,
    fillColor: theme.surfaceColor,
    filled: true,
    fontFamily: theme.typography.fontFamily,
    fontSize: theme.typography.fontSize,
    fontStyle: theme.typography.fontStyle,
    fontWeight: theme.typography.fontWeight,
    strokeColor: theme.borderColor,
    strokeStyle: StrokeStyle.Solid,
    strokeWidth: LineWidth.Two,
  };
  const expected = [
    ...model.nodes.map((node, index) => {
      const xywh = (elements[index] as { xywh?: string } | undefined)?.xywh;
      const bound = xywh ? Bound.deserialize(xywh) : null;
      // Label boxes follow the live/manual contour. Comparing them with cold
      // parser dimensions would reject native text edits as theme drift.
      const current = bound
        ? { ...node, width: bound.w, height: bound.h }
        : node;
      return {
        ...neutralAppearance,
        ...flowchartNodeElementStyle(model, current),
      };
    }),
    ...(model.subgraphs ?? []).map((subgraph) => ({
      ...neutralAppearance,
      ...flowchartSubgraphElementStyle(model, subgraph),
    })),
  ];
  const connectorsMatch = model.edges.every((edge, index) => {
    const connector = connectors[index] as
      | {
          labelStyle?: Record<string, unknown>;
          stroke?: unknown;
        }
      | undefined;
    const edgeStyle = flowchartEdgeElementStyle(model, edge, index);
    const labelStyle = connector?.labelStyle;
    return (
      connector?.stroke === (edgeStyle.stroke ?? theme.borderColor) &&
      (!(edge.displayLabel ?? edge.label) ||
        (labelStyle?.color === theme.textColor &&
          labelStyle.fontFamily === theme.typography.fontFamily &&
          labelStyle.fontSize === edgeStyle.fontSize &&
          labelStyle.fontStyle ===
            (edgeStyle.fontStyle ?? theme.typography.fontStyle) &&
          labelStyle.fontWeight ===
            (edgeStyle.fontWeight ?? theme.typography.fontWeight)))
    );
  });
  return (
    expected.length === elements.length &&
    expected.every((projection, index) =>
      flowchartManagedAppearanceMatches(elements[index], projection),
    ) &&
    connectors.length === model.edges.length &&
    connectorsMatch &&
    flowchartConnectorRoutingMatches(model, elements, connectors)
  );
}

function semanticStyle(value: unknown): MermaidVisualSemanticStyle | "" {
  return value === "accent" ||
    value === "error" ||
    value === "neutral" ||
    value === "processing" ||
    value === "success" ||
    value === "warning"
    ? value
    : "";
}

export function readFlowchartNodeSemanticStyle(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  for (const statement of model.styleStatements ?? []) {
    const parsed = nodeClassStatement(statement);
    const semanticClass = parsed?.classNames.find(
      (className) => semanticStyle(className.toLowerCase()) !== "",
    );
    if (parsed?.nodeIds.includes(node.id) && semanticClass) {
      return semanticStyle(semanticClass.toLowerCase());
    }
  }
  return "";
}

export function readFlowchartEdgeSemanticStyle(
  model: MermaidVisualModel,
  edge: MermaidVisualEdge,
) {
  const edgeIndex = model.edges.findIndex(
    (candidate) => candidate.id === edge.id,
  );
  const style = resolveFlowchartEdgeStyle(model, edgeIndex);
  const stroke = style.stroke?.toLowerCase();
  const semanticStyles = flowchartEdgeSemanticStyles(resolveMermaidGfxTheme());
  if (stroke === semanticStyles.accent.toLowerCase()) return "accent";
  if (stroke === semanticStyles.error.toLowerCase()) return "error";
  if (stroke === semanticStyles.processing.toLowerCase()) return "processing";
  if (stroke === semanticStyles.success.toLowerCase()) return "success";
  if (stroke === semanticStyles.warning.toLowerCase()) return "warning";
  if (stroke === semanticStyles.neutral.toLowerCase()) return "neutral";
  return "";
}

function projectedFlowchartEdgeSemanticStyle(
  model: MermaidVisualModel,
  edgeIndex: number,
): MermaidVisualSemanticStyle | "" {
  const stroke = resolveFlowchartEdgeStyle(
    model,
    edgeIndex,
  ).stroke?.toLowerCase();
  const semanticStyles = flowchartEdgeSemanticStyles(resolveMermaidGfxTheme());
  if (stroke === semanticStyles.accent.toLowerCase()) return "accent";
  if (stroke === semanticStyles.error.toLowerCase()) return "error";
  if (stroke === semanticStyles.processing.toLowerCase()) return "processing";
  if (stroke === semanticStyles.success.toLowerCase()) return "success";
  if (stroke === semanticStyles.warning.toLowerCase()) return "warning";
  if (stroke === semanticStyles.neutral.toLowerCase()) return "neutral";
  return "";
}

function flowchartDefaultLabelFontSize(theme: MermaidGfxTheme) {
  return (
    theme.typography.fontSize +
    (theme.typography.fontSize - theme.typography.minimumReadableFontSize)
  );
}

export function flowchartNodeElementStyle(
  model: MermaidVisualModel,
  node: MermaidVisualNode,
) {
  const style = flowchartElementStyle(model, node);
  const theme = resolveMermaidGfxProjectionTheme();
  const typography = flowchartLabelTypography(style);
  const labelProjection = projectFlowchartNodeLabel(node, typography);
  return {
    strokeColor: theme.secondaryTextColor,
    ...style,
    fontSize: typography.fontSize,
    labelProjection,
    padding: [labelProjection.box.y, labelProjection.box.x] as const,
    mermaidNodeStyleClass: readFlowchartNodeSemanticStyle(model, node),
  };
}

export function flowchartSubgraphElementStyle(
  model: MermaidVisualModel,
  subgraph: MermaidVisualSubgraph,
) {
  const style = flowchartElementStyle(model, subgraph);
  return {
    labelProjection: null,
    ...style,
    ...(style.fontSize === undefined
      ? { fontSize: flowchartDefaultLabelFontSize(resolveMermaidGfxTheme()) }
      : {}),
    padding: mermaidGfxLabelPadding(resolveMermaidGfxTheme()),
  };
}

export function flowchartEdgeElementStyle(
  model: MermaidVisualModel,
  _edge: MermaidVisualEdge,
  edgeIndex: number,
) {
  const style = resolveFlowchartEdgeStyle(model, edgeIndex);
  const strokeWidth = style["stroke-width"]?.match(/^(\d+(?:\.\d+)?)px$/)?.[1];
  const hasDashStyle =
    typeof style["stroke-dasharray"] === "string" &&
    style["stroke-dasharray"] !== "0" &&
    style["stroke-dasharray"].toLowerCase() !== "none";
  const fontSize = stylePixelNumber(style["font-size"]);
  const projectedFontSize =
    fontSize ?? flowchartDefaultLabelFontSize(resolveMermaidGfxTheme());
  return {
    stroke: resolveMermaidGfxProjectionTheme().secondaryTextColor,
    mermaidEdgeVisualStyle: projectedFlowchartEdgeSemanticStyle(
      model,
      edgeIndex,
    ),
    ...(style.stroke ? { stroke: style.stroke } : {}),
    ...(hasDashStyle ? { strokeStyle: StrokeStyle.Dash } : {}),
    fontSize: projectedFontSize,
    ...(style["font-style"]
      ? {
          fontStyle:
            style["font-style"] === "italic"
              ? FontStyle.Italic
              : FontStyle.Normal,
        }
      : {}),
    ...(style["font-weight"]
      ? { fontWeight: styleFontWeight(style["font-weight"]) }
      : {}),
    ...(strokeWidth
      ? { strokeWidth: Math.max(LineWidth.Two, Number(strokeWidth)) }
      : {}),
  };
}

export function flowchartNodeSemanticStyleProps(
  styleName: MermaidVisualSemanticStyle | "",
) {
  const theme = resolveMermaidGfxTheme();
  const style = styleName
    ? flowchartNodeSemanticStyles(theme)[styleName]
    : null;
  return {
    color: style?.color ?? theme.textColor,
    fillColor: style?.fill ?? theme.surfaceColor,
    mermaidNodeStyleClass: styleName,
    strokeColor: style?.stroke ?? theme.secondaryTextColor,
  };
}

export function flowchartEdgeSemanticStyleProps(
  styleName: MermaidVisualSemanticStyle | "",
) {
  const theme = resolveMermaidGfxTheme();
  const styles = flowchartEdgeSemanticStyles(theme);
  return {
    stroke: styleName ? styles[styleName] : theme.secondaryTextColor,
    mermaidEdgeVisualStyle: styleName,
    strokeWidth: LineWidth.Two,
  };
}
