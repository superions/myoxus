// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type MermaidFamilyHostAdapter,
  validateMermaidPageSelectionContainerAction,
} from "../runtime/contracts.js";
import {
  gfxEditorCapabilities,
  type MermaidGfxActionContext,
} from "../runtime/editor-capabilities.js";
import type { MermaidVisualSemanticStyle } from "../runtime/gfx-model.js";
import { mermaidMessages } from "../../i18n.js";
import { resolveFlowchartGfxShapeLabel } from "./editor-ui.js";
import {
  mermaidFlowchartRendererToken,
  type MermaidFlowchartReactHostProps,
} from "./react-host-contract.js";
import {
  flowchartNodeData,
  flowchartNodeLink,
  setFlowchartNodeLink,
  withFlowchartNodeMarkdown,
} from "../../engine/flowchart-node.js";
import {
  canReparentFlowchartGfxSubgraph,
  reorderFlowchartGfxSubgraph,
  reparentFlowchartGfxNodes,
  reparentFlowchartGfxSubgraph,
} from "./gfx-operations.js";
import {
  addFlowchartComment,
  deleteFlowchartComment,
  flowchartCommentAnchorLabel,
  flowchartComments,
  updateFlowchartComment,
  type MermaidFlowchartCommentAnchor,
} from "./comments.js";
import {
  FLOWCHART_ACTION_IDS,
  flowchartActionLabels,
} from "./action-catalog.js";
import { withFlowchartAccessibility } from "./accessibility.js";
import { flowchartSemanticStylePreviews } from "./gfx-style-projection.js";
import { mermaidFlowchartPageSelectionTools } from "./page-selection-tools.js";
import {
  readFlowchartTextFormat,
  setFlowchartTextFormat,
} from "./text-formatting.js";
import { layoutMeasuredFlowchart } from "./layout.js";

function flowchartMutationError() {
  return mermaidMessages.visualMutationSourceRejected("Flowchart");
}

function selectedFlowchartCommentAnchor(
  context: MermaidGfxActionContext,
): MermaidFlowchartCommentAnchor {
  if (context.inspector.selectedEdge) {
    return { anchorId: context.inspector.selectedEdge.id, anchorKind: "edge" };
  }
  if (context.inspector.selectedSubgraph) {
    return {
      anchorId: context.inspector.selectedSubgraph.id,
      anchorKind: "subgraph",
    };
  }
  if (context.inspector.selectedNode) {
    return { anchorId: context.inspector.selectedNode.id, anchorKind: "node" };
  }
  return { anchorKind: "diagram" };
}

function projectFlowchartActions(context: MermaidGfxActionContext) {
  const inspector = context.inspector;
  const selectedSubgraphSiblings = inspector.selectedSubgraph
    ? (context.visualModel.subgraphs ?? []).filter(
        (subgraph) =>
          subgraph.parentId === inspector.selectedSubgraph?.parentId,
      )
    : [];
  const selectedSubgraphSiblingIndex = selectedSubgraphSiblings.findIndex(
    (subgraph) => subgraph.id === inspector.selectedSubgraph?.id,
  );
  const subgraphs = context.visualModel.subgraphs ?? [];
  const comments = flowchartComments(context.visualModel);
  const addSubgraphValidation = validateMermaidPageSelectionContainerAction(
    mermaidFlowchartPageSelectionTools.containerAction,
    context.selectedItems,
    context.visualModel,
  );
  const canAddSubgraph = addSubgraphValidation.valid;
  const canConnect =
    context.selectedNodeIds.length === 2 ||
    (context.selectedNodeIds.length === 1 &&
      context.selectedItems.length === 1);
  const actionLabels = flowchartActionLabels();
  const semanticStylePreviews = flowchartSemanticStylePreviews();
  const textFormat = readFlowchartTextFormat(
    context.visualModel,
    context.selectedItems,
  );
  const addComment = (anchor: MermaidFlowchartCommentAnchor, value: string) => {
    if (context.readonly) return flowchartMutationError();
    const next = addFlowchartComment(context.visualModel, anchor, value);
    if (!next) return flowchartMutationError();
    const result = context.applyVisualModel(next);
    return result.applied
      ? null
      : result.diagnostic || flowchartMutationError();
  };
  const reactProps = {
    typography: textFormat
      ? {
          kind: "typography",
          value: textFormat,
          readonly: context.readonly,
          onChange: (patch) => {
            if (!context.readonly)
              context.applyVisualModel(
                setFlowchartTextFormat(
                  context.visualModel,
                  context.selectedItems,
                  patch,
                ),
              );
          },
        }
      : null,
    projection: "surface",
    addSubgraphDisabledReason: addSubgraphValidation.valid
      ? ""
      : mermaidFlowchartPageSelectionTools.containerAction.validationMessage(
          addSubgraphValidation.code,
        ),
    accessibilityDescription: context.visualModel.accessibilityDescription,
    accessibilityTitle: context.visualModel.accessibilityTitle,
    canAddSubgraph,
    canApplyLayout: true,
    canConnect,
    canMoveSubgraphDown:
      selectedSubgraphSiblingIndex >= 0 &&
      selectedSubgraphSiblingIndex < selectedSubgraphSiblings.length - 1,
    canMoveSubgraphUp: selectedSubgraphSiblingIndex > 0,
    comments: comments.map((comment) => ({
      anchor: flowchartCommentAnchorLabel(context.visualModel, comment),
      anchorId: comment.anchorId,
      anchorKind: comment.anchorKind,
      id: comment.id,
      text: comment.line.replace(/^%%\s*/, ""),
    })),
    connecting: context.connecting,
    connectDisabledReason: canConnect
      ? ""
      : mermaidMessages.flowchartConnectExactlyTwo(),
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    edgeLinkType: inspector.selectedEdge?.linkType ?? null,
    edgeLabel: inspector.selectedEdge?.label ?? null,
    edgeStyle: inspector.selectedEdge?.style ?? null,
    edgeVisualStyle: inspector.selectedEdge
      ? inspector.selectedEdgeStyleStatement || null
      : null,
    labels: {
      addElement: mermaidMessages.visualAddElement(),
      addNode: mermaidMessages.visualAddNode(),
      addSubgraph: mermaidMessages.visualAddSubgraph(),
      accessibility: mermaidMessages.visualAccessibility(),
      accessibilityDescription:
        mermaidMessages.visualAccessibilityDescription(),
      accessibilityTitle: mermaidMessages.visualAccessibilityTitle(),
      applyLayout: mermaidMessages.classApplyLayout(),
      connect: mermaidMessages.visualConnect(),
      connecting: mermaidMessages.visualConnecting(),
      connectingHint: mermaidMessages.visualConnectingHint(),
      deleteComment: mermaidMessages.visualDeleteComment(),
      edgeLinkType: mermaidMessages.selectedEdgeType(),
      edgeLabel: mermaidMessages.selectedEdgeLabel(),
      edgeStyle: mermaidMessages.selectedEdgeStyle(),
      edgeVisualStyle: mermaidMessages.selectedEdgeVisualStyle(),
      exportMmd: mermaidMessages.mmdExport(),
      moreActions: mermaidMessages.visualMoreActions(),
      moveDown: mermaidMessages.visualMoveDown(),
      moveUp: mermaidMessages.visualMoveUp(),
      nodeShape: mermaidMessages.selectedNodeShape(),
      nodeMarkdown: mermaidMessages.visualNodeMarkdown(),
      nodeStyle: mermaidMessages.selectedNodeStyle(),
      pageSelectionBox: mermaidMessages.pageSelectionBox(),
      pageSelectionPointer: mermaidMessages.pageSelectionPointer(),
      pageSelectionTools: mermaidMessages.pageSelectionTools(),
      shapeMenu: mermaidMessages.visualShapeMenu(),
      subgraphTitle: mermaidMessages.selectedSubgraphTitle(),
      toolbar: mermaidMessages.visualEditorLabel(),
      edgeStyleOptions: [
        { label: mermaidMessages.optionSolid(), value: "solid" },
        { label: mermaidMessages.optionDotted(), value: "dotted" },
        { label: mermaidMessages.optionThick(), value: "thick" },
      ],
      edgeLinkTypeOptions: [
        { label: mermaidMessages.optionArrow(), value: "arrow" },
        { label: mermaidMessages.optionOpen(), value: "open" },
        {
          label: mermaidMessages.optionBidirectional(),
          value: "bidirectional",
        },
        { label: mermaidMessages.shapeCircle(), value: "circle" },
        { label: mermaidMessages.optionCross(), value: "cross" },
        { label: mermaidMessages.optionDottedArrow(), value: "dotted" },
        { label: mermaidMessages.optionThickArrow(), value: "thick" },
      ],
      semanticStyleOptions: [
        {
          label: mermaidMessages.optionDefault(),
          preview: semanticStylePreviews[""],
          value: "",
        },
        {
          label: mermaidMessages.optionNeutral(),
          preview: semanticStylePreviews.neutral,
          value: "neutral",
        },
        {
          label: mermaidMessages.optionAccent(),
          preview: semanticStylePreviews.accent,
          value: "accent",
        },
        {
          label: mermaidMessages.optionProcessing(),
          preview: semanticStylePreviews.processing,
          value: "processing",
        },
        {
          label: mermaidMessages.optionSuccess(),
          preview: semanticStylePreviews.success,
          value: "success",
        },
        {
          label: mermaidMessages.optionWarning(),
          preview: semanticStylePreviews.warning,
          value: "warning",
        },
        {
          label: mermaidMessages.optionError(),
          preview: semanticStylePreviews.error,
          value: "error",
        },
      ],
    },
    nodeShape: inspector.selectedNode?.shape ?? context.pendingShape ?? null,
    pageSelection: context.pageSelection,
    pendingShape: context.pendingShape,
    placementHint: context.pendingShape
      ? mermaidMessages.visualPlaceShape(
          resolveFlowchartGfxShapeLabel(context.pendingShape),
        )
      : "",
    edgeActionAnchor: inspector.selectedEdge
      ? context.selectedEdgeAnchor
      : null,
    nodeStyle: inspector.selectedNode
      ? ((inspector.selectedNodeStyleClass ||
          null) as MermaidVisualSemanticStyle | null)
      : null,
    nodeActionAnchor: inspector.selectedNode
      ? context.selectedNodeAnchor
      : null,
    subgraphActionAnchor: inspector.selectedSubgraph
      ? context.selectedSubgraphAnchor
      : null,
    nodeLink: inspector.selectedNode
      ? (flowchartNodeLink(context.visualModel, inspector.selectedNode.id)
          ?.url ?? "")
      : "",
    nodeMarkdown: inspector.selectedNode
      ? flowchartNodeData(inspector.selectedNode).markdown
      : false,
    nodeSubgraphOptions:
      inspector.selectedNode && subgraphs.length > 0
        ? [
            {
              id: "",
              label: "",
              selected: !subgraphs.some((subgraph) =>
                subgraph.nodeIds.includes(inspector.selectedNode!.id),
              ),
            },
            ...subgraphs.map((subgraph) => ({
              id: subgraph.id,
              label: subgraph.title,
              selected: subgraph.nodeIds.includes(inspector.selectedNode!.id),
            })),
          ]
        : [],
    onAddNode: () => context.addNode(),
    onAddSubgraph: context.addContainer,
    onAddComment: (value) =>
      addComment(selectedFlowchartCommentAnchor(context), value),
    onAddDiagramComment: (value) =>
      addComment({ anchorKind: "diagram" }, value),
    onAccessibilityApply: ({ description, title }) => {
      if (context.readonly) return flowchartMutationError();
      const result = context.applyVisualModel(
        withFlowchartAccessibility(context.visualModel, {
          description,
          title,
        }),
      );
      return result.applied
        ? null
        : result.diagnostic || flowchartMutationError();
    },
    onApplyLayout: () => {
      if (context.readonly) return;
      context.applyVisualModel(
        layoutMeasuredFlowchart(
          context.getVisualModel?.() ?? context.visualModel,
        ),
      );
    },
    onConnect: context.connect,
    onCommentChange: (commentId, value) => {
      if (context.readonly) return flowchartMutationError();
      const next = updateFlowchartComment(
        context.visualModel,
        commentId,
        value,
      );
      if (!next) return flowchartMutationError();
      const result = context.applyVisualModel(next);
      return result.applied
        ? null
        : result.diagnostic || flowchartMutationError();
    },
    onCommentDelete: (commentId) => {
      if (context.readonly) return flowchartMutationError();
      const next = deleteFlowchartComment(context.visualModel, commentId);
      if (!next) return flowchartMutationError();
      const result = context.applyVisualModel(next);
      return result.applied
        ? null
        : result.diagnostic || flowchartMutationError();
    },
    onEdgeLinkTypeChange: context.setEdgeLinkType,
    onEdgeLabelChange: context.setEdgeLabel,
    onEdgeStyleChange: context.setEdgeStyle,
    onEdgeVisualStyleChange: context.setEdgeVisualStyle,
    onNodeShapeChange: context.setNodeShape,
    onNodeStyleChange: context.setNodeStyle,
    onEditNodeLabel: context.editNodeLabel,
    onNodeLinkChange: (value) => {
      if (!inspector.selectedNode || context.readonly) return false;
      const next = setFlowchartNodeLink(
        context.visualModel,
        inspector.selectedNode.id,
        value,
      );
      if (!next) return false;
      if (
        JSON.stringify(next.styleStatements ?? []) ===
        JSON.stringify(context.visualModel.styleStatements ?? [])
      ) {
        return true;
      }
      return context.applyVisualModel(next).applied;
    },
    onNodeMarkdownChange: (value) => {
      if (!inspector.selectedNode) return;
      context.applyVisualModel({
        ...context.visualModel,
        nodes: context.visualModel.nodes.map((node) =>
          node.id === inspector.selectedNode?.id
            ? withFlowchartNodeMarkdown(node, value)
            : node,
        ),
      });
    },
    onNodeSubgraphChange: (subgraphId) => {
      if (!inspector.selectedNode) return;
      context.applyVisualModel(
        reparentFlowchartGfxNodes(
          context.visualModel,
          context.selectedNodeIds.length
            ? context.selectedNodeIds
            : [inspector.selectedNode.id],
          subgraphId,
        ),
      );
    },
    onEditSubgraphTitle: context.editSubgraphTitle,
    onExportMmd: context.exportMmd,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    onSubgraphDirectionChange: context.setSubgraphDirection,
    onSubgraphReorder: (delta) => {
      if (!inspector.selectedSubgraph) return;
      context.applyVisualModel(
        reorderFlowchartGfxSubgraph(
          context.visualModel,
          inspector.selectedSubgraph.id,
          delta,
        ),
      );
    },
    onSubgraphParentChange: (parentId) => {
      if (!inspector.selectedSubgraph) return;
      context.applyVisualModel(
        reparentFlowchartGfxSubgraph(
          context.visualModel,
          inspector.selectedSubgraph.id,
          parentId,
        ),
      );
    },
    readonly: context.readonly,
    onWorkareaResize: context.refreshWorkarea,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
    selectionCount: context.selectedItems.length,
    selectionAction: context.selectionAction,
    selectionKey:
      (inspector.selectedNode && `node:${inspector.selectedNode.id}`) ||
      (inspector.selectedEdge && `edge:${inspector.selectedEdge.id}`) ||
      (inspector.selectedSubgraph &&
        `subgraph:${inspector.selectedSubgraph.id}`) ||
      "",
    singleObjectActionsDisabledReason:
      context.selectedNodeIds.length > 1
        ? mermaidMessages.flowchartSingleNodeAction()
        : "",
    shapeOptions: inspector.shapePalette.all.map((shape) => ({
      actionLabel: inspector.selectedNode
        ? mermaidMessages.visualChangeShape(
            resolveFlowchartGfxShapeLabel(shape),
          )
        : mermaidMessages.visualPlaceShape(
            resolveFlowchartGfxShapeLabel(shape),
          ),
      label: resolveFlowchartGfxShapeLabel(shape),
      value: shape,
    })),
    subgraphTitle: inspector.selectedSubgraph?.title ?? null,
    subgraphDirection: inspector.selectedSubgraph?.direction ?? null,
    subgraphParentOptions: inspector.selectedSubgraph
      ? [
          {
            id: "",
            label: "",
            selected: !inspector.selectedSubgraph.parentId,
          },
          ...(context.visualModel.subgraphs ?? [])
            .filter((subgraph) =>
              canReparentFlowchartGfxSubgraph(
                context.visualModel,
                inspector.selectedSubgraph!.id,
                subgraph.id,
              ),
            )
            .map((subgraph) => ({
              id: subgraph.id,
              label: subgraph.title,
              selected: inspector.selectedSubgraph?.parentId === subgraph.id,
            })),
        ]
      : [],
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
  } satisfies MermaidFlowchartReactHostProps;
  const renderProjection = (
    projection: MermaidFlowchartReactHostProps["projection"],
  ) =>
    context.reactHost?.renderFamilyEditor(mermaidFlowchartRendererToken, {
      ...reactProps,
      projection,
    }) ?? null;
  const body = renderProjection("surface") ?? context.workarea;
  // Embedded Edgeless consumes the typed callbacks through the one local
  // surface projection above. Page action projections are neither mounted nor
  // actionable there, so do not create their React/Lit lifecycles in parallel.
  if (context.displayOnly || context.embedded) {
    return {
      actions: { actions: [], portal: false },
      body,
    };
  }
  const disabled = context.readonly || context.displayOnly;
  return {
    actions: {
      actions: [
        {
          disabled,
          id: FLOWCHART_ACTION_IDS.addNode,
          label: actionLabels.addNode,
          popoverProjection: renderProjection("add-node"),
        },
        {
          disabled: disabled || !canAddSubgraph,
          id: FLOWCHART_ACTION_IDS.addSubgraph,
          label: actionLabels.addSubgraph,
          popoverProjection: renderProjection("add-subgraph"),
        },
        {
          disabled: disabled || (!canConnect && !context.connecting),
          id: FLOWCHART_ACTION_IDS.connect,
          label: actionLabels.connect,
          popoverProjection: renderProjection("connect"),
        },
        {
          disabled: disabled || context.selectedNodeIds.length > 1,
          id: FLOWCHART_ACTION_IDS.shapes,
          label: actionLabels.shapes,
          popoverProjection: renderProjection("shapes"),
        },
        {
          disabled: context.displayOnly,
          id: FLOWCHART_ACTION_IDS.comments,
          label: actionLabels.comments,
          popoverProjection: renderProjection("comments"),
        },
        {
          disabled: disabled || !textFormat,
          id: FLOWCHART_ACTION_IDS.appearance,
          label: actionLabels.appearance,
          popoverProjection: renderProjection("appearance"),
        },
        {
          disabled: context.displayOnly,
          id: FLOWCHART_ACTION_IDS.more,
          label: actionLabels.more,
          popoverProjection: renderProjection("more"),
        },
      ],
      portal: false,
    },
    body,
  };
}

export const mermaidFlowchartHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => {
    return gfxEditorCapabilities(
      resolution.visualModel,
      resolution.renderSurface,
      {
        embeddedFacadeSurface: true,
        pageSelectionTools: mermaidFlowchartPageSelectionTools,
        projectActions: projectFlowchartActions,
      },
    );
  },
};
