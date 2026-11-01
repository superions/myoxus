// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TemplateResult } from "lit";
import type {
  FlowchartTextFormat,
  FlowchartTextFormatPatch,
} from "./text-formatting.js";
export type {
  FlowchartTextFormat,
  FlowchartTextFormatPatch,
} from "./text-formatting.js";
import type { MermaidPageViewportProjection } from "../../mermaid-page-viewport-state.js";
import type {
  MermaidPageSelectionProjection,
  MermaidSelectionActionModel,
} from "../runtime/shell-contract.js";
import {
  defineMermaidFamilyReactRendererToken,
  type MermaidFamilyReactRendererToken,
} from "../runtime/react-host.js";
import type {
  MermaidVisualEdgeLinkType,
  MermaidVisualEdgeStyle,
  MermaidVisualNodeShape,
  MermaidVisualSemanticStyle,
} from "../runtime/gfx-model.js";

export type MermaidFlowchartReactHostLabels = {
  readonly addElement: string;
  readonly applyLayout: string;
  readonly addNode: string;
  readonly addSubgraph: string;
  readonly accessibility: string;
  readonly accessibilityDescription: string;
  readonly accessibilityTitle: string;
  readonly connect: string;
  readonly connecting: string;
  readonly connectingHint: string;
  readonly deleteComment: string;
  readonly edgeLinkType: string;
  readonly edgeLabel: string;
  readonly edgeStyle: string;
  readonly edgeVisualStyle: string;
  readonly exportMmd: string;
  readonly moreActions: string;
  readonly moveDown: string;
  readonly moveUp: string;
  readonly nodeShape: string;
  readonly nodeMarkdown: string;
  readonly nodeStyle: string;
  readonly pageSelectionBox: string;
  readonly pageSelectionPointer: string;
  readonly pageSelectionTools: string;
  readonly shapeMenu: string;
  readonly subgraphTitle: string;
  readonly toolbar: string;
  readonly edgeLinkTypeOptions: MermaidSelectOption[];
  readonly edgeStyleOptions: MermaidSelectOption[];
  readonly semanticStyleOptions: MermaidSemanticStyleOption[];
};
export type MermaidSelectOption = {
  readonly label: string;
  readonly value: string;
};
export type MermaidSemanticStyleOption = MermaidSelectOption & {
  readonly preview: {
    readonly backgroundColor: string;
    readonly edgeColor: string;
    readonly foregroundColor: string;
    readonly outlineColor: string;
  };
};
export type MermaidFlowchartReactHostProps = {
  readonly typography: MermaidFlowchartTypographyReactHostProps | null;
  readonly pageViewport: MermaidPageViewportProjection;
  readonly projection:
    | "surface"
    | "add-node"
    | "add-subgraph"
    | "appearance"
    | "comments"
    | "connect"
    | "more"
    | "shapes";
  readonly accessibilityDescription?: string;
  readonly accessibilityTitle?: string;
  readonly canApplyLayout: boolean;
  readonly canAddSubgraph: boolean;
  readonly addSubgraphDisabledReason: string;
  readonly canConnect: boolean;
  readonly canMoveSubgraphDown: boolean;
  readonly canMoveSubgraphUp: boolean;
  readonly comments: ReadonlyArray<{
    readonly anchor: string;
    readonly anchorId?: string;
    readonly anchorKind: "diagram" | "edge" | "node" | "subgraph";
    readonly id: string;
    readonly text: string;
  }>;
  readonly displayOnly: boolean;
  readonly embedded: boolean;
  readonly embeddedEditing: boolean;
  readonly edgeLinkType: MermaidVisualEdgeLinkType | null;
  readonly edgeLabel: string | null;
  readonly edgeStyle: MermaidVisualEdgeStyle | null;
  readonly edgeVisualStyle: MermaidVisualSemanticStyle | null;
  readonly edgeActionAnchor: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly labels: MermaidFlowchartReactHostLabels;
  readonly pageSelection: MermaidPageSelectionProjection | null;
  readonly pendingShape: MermaidVisualNodeShape | null;
  readonly placementHint: string;
  readonly nodeShape: MermaidVisualNodeShape | null;
  readonly nodeStyle: MermaidVisualSemanticStyle | null;
  readonly nodeActionAnchor: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly subgraphActionAnchor: {
    readonly left: number;
    readonly top: number;
  } | null;
  readonly nodeMarkdown: boolean;
  readonly nodeLink: string;
  readonly nodeSubgraphOptions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly selected: boolean;
  }>;
  readonly connecting: boolean;
  readonly connectDisabledReason: string;
  readonly onAddNode: () => void;
  readonly onAddSubgraph: () => void;
  readonly onAddComment: (value: string) => string | null;
  readonly onAddDiagramComment: (value: string) => string | null;
  readonly onAccessibilityApply: (values: {
    readonly description: string;
    readonly title: string;
  }) => string | null;
  readonly onApplyLayout: () => void;
  readonly onConnect: () => void;
  readonly onCommentChange: (commentId: string, value: string) => string | null;
  readonly onCommentDelete: (commentId: string) => string | null;
  readonly onEdgeLinkTypeChange: (value: MermaidVisualEdgeLinkType) => void;
  readonly onEdgeLabelChange: (value: string) => void;
  readonly onEdgeStyleChange: (value: MermaidVisualEdgeStyle) => void;
  readonly onEdgeVisualStyleChange: (
    value: MermaidVisualSemanticStyle | null,
  ) => void;
  readonly onNodeShapeChange: (value: MermaidVisualNodeShape) => void;
  readonly onNodeStyleChange: (
    value: MermaidVisualSemanticStyle | null,
  ) => void;
  readonly onEditNodeLabel: () => void;
  readonly onNodeLinkChange: (value: string) => boolean;
  readonly onNodeMarkdownChange: (value: boolean) => void;
  readonly onNodeSubgraphChange: (subgraphId: string) => void;
  readonly onEmbeddedActionsInsetChange: (height: number) => void;
  readonly onEditSubgraphTitle: () => void;
  readonly onExportMmd: () => void;
  readonly onSubgraphDirectionChange: (
    value: "TD" | "TB" | "BT" | "LR" | "RL",
  ) => void;
  readonly onSubgraphReorder: (delta: -1 | 1) => void;
  readonly onSubgraphParentChange: (parentId: string) => void;
  readonly readonly: boolean;
  readonly onWorkareaResize: () => void;
  readonly resolveReturnFocusTarget: () => HTMLElement | null;
  readonly selectionCount: number;
  readonly selectionAction: MermaidSelectionActionModel;
  readonly shapeOptions: ReadonlyArray<{
    readonly actionLabel: string;
    readonly label: string;
    readonly value: MermaidVisualNodeShape;
  }>;
  readonly selectionKey: string;
  readonly singleObjectActionsDisabledReason: string;
  readonly subgraphTitle: string | null;
  readonly subgraphDirection: "TD" | "TB" | "BT" | "LR" | "RL" | null;
  readonly subgraphParentOptions: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly selected: boolean;
  }>;
  readonly workarea: TemplateResult | string | null;
  readonly workareaFooter?: TemplateResult | string | null;
};
export type MermaidFlowchartMetadataReactHostProps = {
  readonly accessibilityDescription?: string;
  readonly accessibilityTitle?: string;
  readonly comments: MermaidFlowchartReactHostProps["comments"];
  readonly kind: "comments" | "more";
  readonly labels: Pick<
    MermaidFlowchartReactHostLabels,
    | "accessibility"
    | "accessibilityDescription"
    | "accessibilityTitle"
    | "deleteComment"
  >;
  readonly onAddComment: MermaidFlowchartReactHostProps["onAddComment"];
  readonly onAccessibilityApply: MermaidFlowchartReactHostProps["onAccessibilityApply"];
  readonly onCommentChange: MermaidFlowchartReactHostProps["onCommentChange"];
  readonly onCommentDelete: MermaidFlowchartReactHostProps["onCommentDelete"];
  readonly readonly: boolean;
  readonly selectionKey: string;
};

export type MermaidFlowchartReactRendererProps =
  | MermaidFlowchartReactHostProps
  | MermaidFlowchartMetadataReactHostProps
  | MermaidFlowchartTypographyReactHostProps;

export type MermaidFlowchartTypographyReactHostProps = {
  readonly kind: "typography";
  readonly value: FlowchartTextFormat;
  readonly onChange: (patch: FlowchartTextFormatPatch) => void;
  readonly readonly: boolean;
};

export const mermaidFlowchartRendererToken: MermaidFamilyReactRendererToken<MermaidFlowchartReactRendererProps> =
  defineMermaidFamilyReactRendererToken("flowchart");
