// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapDiagnostic } from "./diagnostics.js";
import type { TreemapRange, TreemapSourceDocument } from "./source-document.js";

export type TreemapQuote = "double" | "single";

export type TreemapNode = {
  readonly id: string;
  readonly recordId: string;
  readonly label: string;
  readonly labelQuote: TreemapQuote;
  readonly labelRange: TreemapRange;
  readonly indent: string;
  readonly indentRange: TreemapRange;
  readonly separator: ":" | "," | null;
  readonly separatorRange?: TreemapRange;
  readonly value: number | null;
  readonly valueLexeme: string | null;
  readonly valueRange?: TreemapRange;
  readonly className: string | null;
  readonly classRange?: TreemapRange;
  readonly parentId: string | null;
  readonly depth: number;
  readonly sourceOrder: number;
  readonly renderable: boolean;
};

export type TreemapClassDeclaration = {
  readonly property: string;
  readonly value: string;
  readonly raw: string;
};

export type TreemapClassDef = {
  readonly id: string;
  readonly recordId: string;
  readonly name: string;
  readonly nameRange: TreemapRange;
  readonly styleRange?: TreemapRange;
  readonly declarations: readonly TreemapClassDeclaration[];
  readonly semicolon: boolean;
};

export type TreemapCommentAnchor =
  | { readonly kind: "diagram" }
  | {
      readonly kind: "node" | "class-def" | "metadata";
      readonly id: string;
    };

export type TreemapComment = {
  readonly id: string;
  readonly recordId: string;
  readonly text: string;
  readonly anchor: TreemapCommentAnchor;
};

export type TreemapConfig = {
  readonly useMaxWidth: boolean;
  readonly padding: number;
  readonly diagramPadding: number;
  readonly showValues: boolean;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly borderWidth: number;
  readonly valueFontSize: number;
  readonly labelFontSize: number;
  readonly valueFormat: string;
};

export const TREEMAP_DEFAULT_CONFIG: Readonly<TreemapConfig> = {
  useMaxWidth: true,
  padding: 10,
  diagramPadding: 8,
  showValues: true,
  nodeWidth: 100,
  nodeHeight: 40,
  borderWidth: 1,
  valueFontSize: 12,
  labelFontSize: 14,
  valueFormat: ",",
};

export type TreemapModel = {
  readonly diagramType: "treemap";
  readonly version: 2;
  readonly sourceDocument: TreemapSourceDocument;
  readonly nodes: readonly TreemapNode[];
  readonly roots: readonly string[];
  readonly classDefs: readonly TreemapClassDef[];
  readonly comments: readonly TreemapComment[];
  readonly diagnostics: readonly TreemapDiagnostic[];
  readonly ambiguous: boolean;
  readonly config: TreemapConfig;
  readonly configOverrides: readonly (keyof TreemapConfig)[];
  readonly title: string;
  readonly accessibilityTitle: string;
  readonly accessibilityDescription: string;
};

export type TreemapSelection = {
  readonly kind: "node" | "class-def" | "comment";
  readonly id: string;
} | null;

export function treemapChildren(model: TreemapModel, parentId: string | null) {
  return model.nodes.filter((node) => node.parentId === parentId);
}

export function treemapDescendantIds(model: TreemapModel, nodeId: string) {
  const result = new Set<string>();
  const visit = (id: string) => {
    for (const child of treemapChildren(model, id)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      visit(child.id);
    }
  };
  visit(nodeId);
  return result;
}

export function treemapNodeAggregate(
  model: TreemapModel,
  nodeId: string,
): number {
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return 0;
  if (node.value !== null) return Math.max(0, node.value);
  return treemapChildren(model, nodeId).reduce(
    (sum, child) => sum + treemapNodeAggregate(model, child.id),
    0,
  );
}
