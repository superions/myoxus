// SPDX-License-Identifier: AGPL-3.0-or-later

import { isValidUrl, normalizeUrl } from "@virgultum/shared/utils";

import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../families/runtime/gfx-family-data.js";
import type {
  MermaidVisualModel,
  MermaidVisualNode,
} from "../families/runtime/gfx-model.js";

const FLOWCHART_NODE_KIND = "node";

const CLICK_STATEMENT_RE =
  /^click\s+([A-Za-z0-9_][\w-]*)\s+(?:href\s+)?"((?:\\.|[^"])*)"(?:\s+"((?:\\.|[^"])*)")?(?:\s+_(self|blank|parent|top))?\s*;?$/i;
const CLICK_STATEMENT_NODE_RE = /^click\s+([A-Za-z0-9_][\w-]*)\s+\S+/i;

export type MermaidFlowchartNodeData = {
  readonly markdown: boolean;
};

export type MermaidFlowchartNodeLink = {
  readonly target?: "blank" | "parent" | "self" | "top";
  readonly tooltip: string;
  readonly url: string;
};

function unescapeQuoted(value: string) {
  return value.replace(/\\([\\"])/g, "$1");
}

function escapeQuoted(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function flowchartNodeData(
  node: Pick<MermaidVisualNode, "familyData">,
): MermaidFlowchartNodeData {
  const payload = mermaidVisualFamilyPayload(node.familyData, "flowchart");
  return {
    markdown:
      payload?.kind === FLOWCHART_NODE_KIND && payload.markdown === true,
  };
}

export function flowchartNodeFamilyData(markdown: boolean) {
  return markdown
    ? createMermaidVisualFamilyData("flowchart", {
        kind: FLOWCHART_NODE_KIND,
        markdown: true,
      })
    : undefined;
}

export function withFlowchartNodeMarkdown(
  node: MermaidVisualNode,
  markdown: boolean,
): MermaidVisualNode {
  return {
    ...node,
    familyData: flowchartNodeFamilyData(markdown),
  };
}

export function parseFlowchartClickStatement(statement: string) {
  const match = CLICK_STATEMENT_RE.exec(statement.trim());
  if (!match?.[1] || match[2] === undefined) return null;
  return {
    nodeId: match[1],
    target: match[4] as MermaidFlowchartNodeLink["target"],
    tooltip: unescapeQuoted(match[3] ?? ""),
    url: unescapeQuoted(match[2]),
  };
}

export function flowchartClickStatementNodeId(statement: string) {
  return CLICK_STATEMENT_NODE_RE.exec(statement.trim())?.[1] ?? null;
}

export function flowchartNodeLink(
  model: Pick<MermaidVisualModel, "styleStatements">,
  nodeId: string,
): MermaidFlowchartNodeLink | null {
  for (const statement of model.styleStatements ?? []) {
    const link = parseFlowchartClickStatement(statement);
    if (link?.nodeId === nodeId) {
      return {
        target: link.target,
        tooltip: link.tooltip,
        url: link.url,
      };
    }
  }
  return null;
}

export function setFlowchartNodeLink(
  model: MermaidVisualModel,
  nodeId: string,
  rawUrl: string,
): MermaidVisualModel | null {
  const trimmed = rawUrl.trim();
  const url = trimmed ? normalizeUrl(trimmed) : "";
  if (trimmed && (!url || !isValidUrl(url, "https://myoxus.local"))) {
    return null;
  }

  const previous = flowchartNodeLink(model, nodeId);
  const styleStatements: string[] = [];
  let insertionIndex: number | undefined;
  for (const statement of model.styleStatements ?? []) {
    if (flowchartClickStatementNodeId(statement) === nodeId) {
      insertionIndex ??= styleStatements.length;
    } else {
      styleStatements.push(statement);
    }
  }
  if (url) {
    const tooltip = previous?.tooltip
      ? ` "${escapeQuoted(previous.tooltip)}"`
      : "";
    const target = previous?.target ? ` _${previous.target}` : "";
    styleStatements.splice(
      insertionIndex ?? styleStatements.length,
      0,
      `click ${nodeId} href "${escapeQuoted(url)}"${tooltip}${target}`,
    );
  }
  return { ...model, styleStatements };
}
