// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolbarContext } from "@virgultum/shared/services";

import { deleteMermaidGfxSelectionCommand } from "../../families/runtime/gfx-commands.js";
import { resolveTypeOwnedMermaidGfxDeletionPlan } from "../../families/runtime/gfx-graph-operations.js";
import {
  addMermaidArchitectureComment,
  deleteMermaidArchitectureComment,
  mermaidArchitectureDiagramConfig,
  updateMermaidArchitectureComment,
} from "../../engine/architecture/index.js";
import { mermaidMessages } from "../../i18n.js";
import { getMermaidBlockSource } from "../../utils.js";
import {
  applyArchitectureEdgelessInteraction,
  architectureSelection,
  architectureSelectionDescriptor,
  type ArchitectureEdgelessOwnerState,
  runArchitectureMutation,
  selectedArchitectureItems,
} from "./context.js";
import { architectureCommentAnchorLabel } from "../../families/architecture/comment-projection.js";
import type { MermaidArchitectureGfxControl } from "../../families/architecture/control-contract.js";
import {
  architectureEdgeGfxData,
  architectureModelGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "../../families/architecture/gfx-data.js";
import { architectureIconIsResolved } from "../../families/architecture/icon-display.js";
import {
  architectureReactLabels,
  readArchitectureInteractionModel,
  resolveArchitectureAlignmentInteraction,
  resolveArchitectureAlignmentDeleteInteraction,
  resolveArchitectureCommentInteraction,
  resolveArchitectureDiagramInteraction,
  resolveArchitectureFieldsInteraction,
} from "../../families/architecture/interaction-controller.js";
import { architecturePropertyFields } from "../../families/architecture/properties.js";
import type {
  MermaidArchitectureCommentAnchor,
  MermaidArchitectureCommentsReactHostProps,
  MermaidArchitectureDeleteConfirmationReactHostProps,
  MermaidArchitecturePropertiesReactHostProps,
  MermaidArchitectureSettingsReactHostProps,
} from "../../families/architecture/react-host-contract.js";

function architectureEdgelessInspector(
  state: ArchitectureEdgelessOwnerState,
  selection: NonNullable<ReturnType<typeof architectureSelection>>,
) {
  return {
    selectedEdge: state.visualModel.edges.find(
      (candidate) => candidate.id === selection.edgeId,
    ),
    selectedEdgeStyleStatement: "" as const,
    selectedNode: state.visualModel.nodes.find(
      (candidate) => candidate.id === selection.nodeId,
    ),
    selectedNodeStyleClass: "",
    selectedSubgraph: state.visualModel.subgraphs?.find(
      (candidate) => candidate.id === selection.subgraphId,
    ),
    shapePalette: { all: [] },
  };
}

export function architectureEdgelessAlignmentForSelection(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
) {
  const items = selectedArchitectureItems(context);
  if (items.length < 2 || items.some((item) => item.kind !== "node")) {
    return null;
  }
  const nodeIds = items.map((item) => item.editKey);
  return (
    architectureModelGfxData(state.visualModel)?.alignments.find(
      (alignment) =>
        alignment.members.length === nodeIds.length &&
        alignment.members.every((member) => nodeIds.includes(member)),
    ) ?? null
  );
}

function architectureEdgelessAnchor(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
  selection: ReturnType<typeof architectureSelection>,
): MermaidArchitectureCommentAnchor {
  const alignment = architectureEdgelessAlignmentForSelection(context, state);
  if (alignment) {
    return { anchorId: alignment.id, anchorKind: "alignment" };
  }
  if (selection?.edgeId) {
    const edge = state.visualModel.edges.find(
      (candidate) => candidate.id === selection.edgeId,
    );
    return {
      anchorId: edge
        ? architectureEdgeGfxData(edge)?.sourceId || edge.id
        : selection.edgeId,
      anchorKind: "edge",
    };
  }
  if (selection?.subgraphId) {
    const subgraph = state.visualModel.subgraphs?.find(
      (candidate) => candidate.id === selection.subgraphId,
    );
    return {
      anchorId:
        (subgraph && architectureSubgraphGfxData(subgraph)?.sourceId) ||
        selection.subgraphId,
      anchorKind: "group",
    };
  }
  if (selection?.nodeId) {
    const node = state.visualModel.nodes.find(
      (candidate) => candidate.id === selection.nodeId,
    );
    return {
      anchorId:
        (node && architectureNodeGfxData(node)?.sourceId) || selection.nodeId,
      anchorKind:
        node && architectureNodeGfxData(node)?.kind === "junction"
          ? "junction"
          : "service",
    };
  }
  return { anchorKind: "diagram" };
}

function architectureSelectionKey(
  selection: ReturnType<typeof architectureSelection>,
) {
  return (
    (selection?.nodeId && `node:${selection.nodeId}`) ||
    (selection?.edgeId && `edge:${selection.edgeId}`) ||
    (selection?.subgraphId && `subgraph:${selection.subgraphId}`) ||
    "diagram"
  );
}

function architectureCommentProjection(
  state: ArchitectureEdgelessOwnerState,
  anchor: MermaidArchitectureCommentAnchor,
) {
  const parsed = readArchitectureInteractionModel(
    getMermaidBlockSource(state.owner.props),
  );
  if (!parsed) return null;
  const comments = (parsed.comments ?? []).filter(
    (comment) =>
      comment.anchorKind === anchor.anchorKind &&
      comment.anchorId === anchor.anchorId,
  );
  return {
    comments: comments.map((comment) => ({
      anchor: architectureCommentAnchorLabel(parsed, comment),
      anchorId: comment.anchorId,
      anchorKind: comment.anchorKind,
      id: comment.id,
      text: comment.line.replace(/^%%\s*/, ""),
    })),
    parsed,
  };
}

function applyArchitectureComments(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
  mutate: Parameters<typeof resolveArchitectureCommentInteraction>[2],
) {
  return applyArchitectureEdgelessInteraction(
    context,
    state,
    resolveArchitectureCommentInteraction(
      getMermaidBlockSource(state.owner.props),
      state.visualModel,
      mutate,
    ),
  );
}

export function architectureEdgelessPropertiesProjection(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
): MermaidArchitecturePropertiesReactHostProps | null {
  const selection = architectureSelection(context, state);
  if (!selection) return null;
  const inspector = architectureEdgelessInspector(state, selection);
  const fields = architecturePropertyFields(state.visualModel, inspector);
  if (!fields.length) return null;
  const selectedArchitecture = inspector.selectedNode
    ? architectureNodeGfxData(inspector.selectedNode)
    : null;
  const selectedGroupArchitecture = inspector.selectedSubgraph
    ? architectureSubgraphGfxData(inspector.selectedSubgraph)
    : null;
  const icon = selectedArchitecture?.hasIcon
    ? {
        icon: selectedArchitecture.icon,
        kind: selectedArchitecture.iconKind,
      }
    : selectedGroupArchitecture?.hasIcon
      ? { icon: selectedGroupArchitecture.icon, kind: "icon" as const }
      : null;
  return {
    surface: "properties",
    fields,
    iconDiagnostic:
      icon && !architectureIconIsResolved(icon.icon, icon.kind)
        ? mermaidMessages.architectureIconUnavailable(icon.icon)
        : "",
    labels: architectureReactLabels(),
    onPropertiesApply: (values) => {
      if (context.readonly) {
        return mermaidMessages.architectureInvalidProperties();
      }
      const currentValues = new Map(
        fields.map((field) => [field.control, field.value]),
      );
      const targetNodeKind = values.find(
        ({ control }) => control === "architectureNodeKind",
      )?.value;
      const changedValues = values
        .filter(({ control, value }) => currentValues.get(control) !== value)
        .filter(
          ({ control }) =>
            targetNodeKind !== "junction" ||
            (control !== "architectureServiceIcon" &&
              control !== "architectureServiceIconKind"),
        )
        .sort(({ control: left }, { control: right }) => {
          const isId = (control: MermaidArchitectureGfxControl) =>
            control === "architectureNodeId" ||
            control === "architectureGroupId";
          return Number(isId(left)) - Number(isId(right));
        });
      if (!changedValues.length) return null;
      return applyArchitectureEdgelessInteraction(
        context,
        state,
        resolveArchitectureFieldsInteraction(
          getMermaidBlockSource(state.owner.props),
          state.visualModel,
          selection,
          changedValues,
        ),
      );
    },
    readonly: context.readonly,
    selectionKey: architectureSelectionKey(selection),
  };
}

export function architectureEdgelessCommentsProjection(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
): MermaidArchitectureCommentsReactHostProps | null {
  const selection = architectureSelection(context, state);
  const anchor = architectureEdgelessAnchor(context, state, selection);
  const projection = architectureCommentProjection(state, anchor);
  if (!projection) return null;
  return {
    surface: "comments",
    anchor,
    comments: projection.comments,
    labels: architectureReactLabels(),
    onAddComment: (value, target = anchor) =>
      applyArchitectureComments(context, state, (model) =>
        addMermaidArchitectureComment(model, target, value),
      ),
    onCommentChange: (commentId, value) =>
      applyArchitectureComments(context, state, (model) =>
        updateMermaidArchitectureComment(model, commentId, value),
      ),
    onCommentDelete: (commentId) =>
      applyArchitectureComments(context, state, (model) =>
        deleteMermaidArchitectureComment(model, commentId),
      ),
    readonly: context.readonly,
    selectionKey:
      anchor.anchorKind === "alignment" && anchor.anchorId
        ? `alignment:${anchor.anchorId}`
        : architectureSelectionKey(selection),
  };
}

export function architectureEdgelessSettingsProjection(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
): MermaidArchitectureSettingsReactHostProps | null {
  const parsed = readArchitectureInteractionModel(
    getMermaidBlockSource(state.owner.props),
  );
  if (!parsed) return null;
  return {
    surface: "settings",
    accessibilityDescription: parsed.accessibilityDescription,
    accessibilityTitle: parsed.accessibilityTitle,
    comments: (parsed.comments ?? []).map((comment) => ({
      anchor: architectureCommentAnchorLabel(parsed, comment),
      anchorId: comment.anchorId,
      anchorKind: comment.anchorKind,
      id: comment.id,
      text: comment.line.replace(/^%%\s*/, ""),
    })),
    diagramConfig: mermaidArchitectureDiagramConfig(parsed),
    labels: architectureReactLabels(),
    onAddComment: (value, anchor = { anchorKind: "diagram" }) =>
      applyArchitectureComments(context, state, (model) =>
        addMermaidArchitectureComment(model, anchor, value),
      ),
    onCommentChange: (commentId, value) =>
      applyArchitectureComments(context, state, (model) =>
        updateMermaidArchitectureComment(model, commentId, value),
      ),
    onCommentDelete: (commentId) =>
      applyArchitectureComments(context, state, (model) =>
        deleteMermaidArchitectureComment(model, commentId),
      ),
    onDiagramSettingsApply: (values) =>
      applyArchitectureEdgelessInteraction(
        context,
        state,
        resolveArchitectureDiagramInteraction(
          getMermaidBlockSource(state.owner.props),
          state.visualModel,
          values,
        ),
      ),
    readonly: context.readonly,
    selectionKey: "diagram",
  };
}

export function architectureEdgelessDeleteProjection(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
): MermaidArchitectureDeleteConfirmationReactHostProps | null {
  const selection = architectureSelectionDescriptor(context);
  if (!selection) return null;
  const deletionPlan = resolveTypeOwnedMermaidGfxDeletionPlan(
    state.visualModel,
    selection,
  );
  if (!deletionPlan) return null;
  return {
    surface: "delete-confirmation",
    resolveReturnFocusTarget: () =>
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
    selectionAction: {
      confirmation: deletionPlan.requiresConfirmation
        ? {
            description: mermaidMessages.selectionDeleteImpact(),
            items: [...deletionPlan.impact],
          }
        : undefined,
      disabled: context.readonly,
      label: mermaidMessages.visualDelete(),
      onSelect: () => {
        const applied = runArchitectureMutation(
          context,
          state.owner,
          () =>
            context.command.exec(deleteMermaidGfxSelectionCommand, {
              edgeIds: selection.edgeIds,
              model: state.owner,
              nodeIds: selection.nodeIds,
              subgraphIds: selection.subgraphIds,
            })[0],
        );
        if (applied) {
          context.gfx.selection.set({ editing: false, elements: [] });
        }
      },
    },
  };
}

export function applyArchitectureEdgelessAlignment(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
  nodeIds: readonly string[],
  direction: "column" | "row",
) {
  const alignment = architectureEdgelessAlignmentForSelection(context, state);
  return applyArchitectureEdgelessInteraction(
    context,
    state,
    resolveArchitectureAlignmentInteraction(
      getMermaidBlockSource(state.owner.props),
      state.visualModel,
      nodeIds,
      direction,
      alignment?.id,
    ),
  );
}

export function deleteArchitectureEdgelessAlignment(
  context: ToolbarContext,
  state: ArchitectureEdgelessOwnerState,
) {
  const alignment = architectureEdgelessAlignmentForSelection(context, state);
  if (!alignment) return null;
  return applyArchitectureEdgelessInteraction(
    context,
    state,
    resolveArchitectureAlignmentDeleteInteraction(
      getMermaidBlockSource(state.owner.props),
      state.visualModel,
      alignment.id,
    ),
  );
}
