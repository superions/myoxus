// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  addMermaidArchitectureComment,
  deleteMermaidArchitectureAlignment,
  deleteMermaidArchitectureComment,
  parseMermaidArchitectureSource,
  mermaidArchitectureDiagramConfig,
  updateMermaidArchitectureDiagram,
  setMermaidArchitectureAlignment,
  updateMermaidArchitectureAlignment,
  updateMermaidArchitectureComment,
  type MermaidArchitectureConfig,
  type MermaidArchitectureComment,
  type MermaidArchitectureCommandResult,
} from "../../engine/architecture/index.js";
import { mermaidMessages } from "../../i18n.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import { validateMermaidPageSelectionContainerAction } from "../runtime/contracts.js";
import { alignArchitectureGfxNodes } from "./alignment.js";
import { architectureCommandDiagnosisMessage } from "./command-diagnosis.js";
import type { MermaidArchitectureGfxControl } from "./control-contract.js";
import {
  architectureEdgeGfxData,
  architectureModelFamilyData,
  architectureModelGfxData,
  architectureNodeGfxData,
  architectureSubgraphGfxData,
} from "./gfx-data.js";
import { architectureIconIsResolved } from "./icon-display.js";
import { architecturePropertyFields } from "./properties.js";
import { applyArchitectureSemanticFieldMutations } from "./mutations/index.js";
import { projectArchitectureSemanticCommand } from "./mutations/index.js";
import type { MermaidArchitectureFieldValue } from "./mutations/index.js";
import type { MermaidArchitectureEditorReactHostProps } from "./react-host-contract.js";
import { architectureModelToGfxVisualModel } from "./visual-model.js";
import { mermaidArchitecturePageSelectionTools } from "./page-selection-tools.js";
import { projectArchitectureComments } from "./comment-projection.js";

export { architectureCommentAnchorLabel } from "./comment-projection.js";

export type ArchitectureInteractionResolution =
  | {
      readonly changed: false;
      readonly diagnostic: string;
    }
  | {
      readonly changed: true;
      readonly selectionAfter: MermaidArchitectureCommandResult["selectionAfter"];
      readonly visualModel: MermaidGfxActionContext["visualModel"];
    };

export function readArchitectureInteractionModel(source: string) {
  return parseMermaidArchitectureSource(source);
}

export function architectureVisualSelectionAfter(
  visualModel: MermaidGfxActionContext["visualModel"],
  selection: MermaidArchitectureCommandResult["selectionAfter"],
) {
  if (!selection.id) return null;
  if (selection.kind === "service" || selection.kind === "junction") {
    return visualModel.nodes.some((node) => node.id === selection.id)
      ? { id: selection.id, kind: "node" as const }
      : null;
  }
  if (selection.kind === "group") {
    return visualModel.subgraphs?.some((group) => group.id === selection.id)
      ? { id: selection.id, kind: "subgraph" as const }
      : null;
  }
  if (selection.kind === "edge") {
    const edge = visualModel.edges.find(
      (candidate) =>
        candidate.id === selection.id ||
        architectureEdgeGfxData(candidate)?.sourceId === selection.id,
    );
    return edge ? { id: edge.id, kind: "edge" as const } : null;
  }
  return null;
}

function rejectedArchitectureInteraction(
  command?: MermaidArchitectureCommandResult,
): ArchitectureInteractionResolution {
  return {
    changed: false,
    diagnostic: command
      ? (architectureCommandDiagnosisMessage(command) ??
        mermaidMessages.architectureInvalidProperties())
      : mermaidMessages.architectureInvalidProperties(),
  };
}

function resolveArchitectureCommandInteraction(
  source: string,
  visualModel: MermaidGfxActionContext["visualModel"],
  selectionBefore: {
    readonly edgeId?: string;
    readonly nodeId?: string;
    readonly subgraphId?: string;
  },
  run: (
    model: NonNullable<ReturnType<typeof parseMermaidArchitectureSource>>,
  ) => MermaidArchitectureCommandResult,
): ArchitectureInteractionResolution {
  const parsed = parseMermaidArchitectureSource(source);
  if (!parsed) return rejectedArchitectureInteraction();
  const command = run(parsed);
  if (!command.changed) return rejectedArchitectureInteraction(command);
  const projected = projectArchitectureSemanticCommand({
    model: command.model,
    selectionAfter: command.selectionAfter,
    selectionBefore,
    visualModel,
  });
  return projected
    ? {
        changed: true,
        selectionAfter: command.selectionAfter,
        visualModel: projected,
      }
    : rejectedArchitectureInteraction();
}

export function resolveArchitectureFieldsInteraction(
  source: string,
  visualModel: MermaidGfxActionContext["visualModel"],
  selection: {
    readonly edgeId?: string;
    readonly nodeId?: string;
    readonly subgraphId?: string;
  },
  values: ReadonlyArray<MermaidArchitectureFieldValue>,
): ArchitectureInteractionResolution {
  const parsed = parseMermaidArchitectureSource(source);
  if (!parsed) return rejectedArchitectureInteraction();
  const mutation = applyArchitectureSemanticFieldMutations(
    parsed,
    visualModel,
    selection,
    values,
  );
  return mutation.changed
    ? {
        changed: true,
        selectionAfter: mutation.selectionAfter,
        visualModel: mutation.visualModel,
      }
    : rejectedArchitectureInteraction(mutation.command);
}

export function resolveArchitectureDiagramInteraction(
  source: string,
  visualModel: MermaidGfxActionContext["visualModel"],
  values: {
    readonly accessibilityDescription?: string;
    readonly accessibilityTitle?: string;
    readonly config?: MermaidArchitectureConfig;
  },
) {
  // Diagram settings change semantic renderer inputs, never established GFX
  // positions. Reflow remains an explicit, previewed Architecture action.
  return resolveArchitectureCommandInteraction(
    source,
    visualModel,
    {},
    (model) => updateMermaidArchitectureDiagram(model, values),
  );
}

export function resolveArchitectureCommentInteraction(
  source: string,
  visualModel: MermaidGfxActionContext["visualModel"],
  run: (
    model: NonNullable<ReturnType<typeof parseMermaidArchitectureSource>>,
  ) => MermaidArchitectureCommandResult,
) {
  return resolveArchitectureCommandInteraction(source, visualModel, {}, run);
}

export function resolveArchitectureAlignmentInteraction(
  source: string,
  visualModel: MermaidGfxActionContext["visualModel"],
  nodeIds: readonly string[],
  direction: "column" | "row",
  alignmentId?: string,
): ArchitectureInteractionResolution {
  const parsed = parseMermaidArchitectureSource(source);
  if (!parsed) return rejectedArchitectureInteraction();
  const command = alignmentId
    ? updateMermaidArchitectureAlignment(
        parsed,
        alignmentId,
        nodeIds,
        direction,
      )
    : setMermaidArchitectureAlignment(parsed, nodeIds, direction);
  if (
    !command.changed &&
    command.diagnosis?.code !== "architecture.no-change"
  ) {
    return rejectedArchitectureInteraction(command);
  }
  const aligned = alignArchitectureGfxNodes(visualModel, nodeIds, direction);
  if (!aligned) return rejectedArchitectureInteraction(command);
  const projected = architectureModelGfxData(visualModel);
  return {
    changed: true,
    selectionAfter: command.selectionAfter,
    visualModel: {
      ...aligned,
      familyData: architectureModelFamilyData(
        command.model.alignments,
        projected?.comments ?? parsed.comments ?? [],
        {
          config: projected?.config ?? mermaidArchitectureDiagramConfig(parsed),
          directives: projected?.directives ?? parsed.directives,
        },
      ),
    },
  };
}

export function resolveArchitectureAlignmentDeleteInteraction(
  source: string,
  visualModel: MermaidGfxActionContext["visualModel"],
  alignmentId: string,
) {
  return resolveArchitectureCommandInteraction(
    source,
    visualModel,
    {},
    (model) => deleteMermaidArchitectureAlignment(model, alignmentId),
  );
}

function selectedArchitectureAnchor(
  context: MermaidGfxActionContext,
): Pick<MermaidArchitectureComment, "anchorId" | "anchorKind"> {
  if (context.selectedAlignmentGuideId) {
    return {
      anchorId: context.selectedAlignmentGuideId,
      anchorKind: "alignment",
    };
  }
  if (context.inspector.selectedEdge) {
    const sourceId = architectureEdgeGfxData(
      context.inspector.selectedEdge,
    )?.sourceId;
    return {
      anchorId: sourceId || context.inspector.selectedEdge.id,
      anchorKind: "edge",
    };
  }
  if (context.inspector.selectedSubgraph) {
    const sourceId = architectureSubgraphGfxData(
      context.inspector.selectedSubgraph,
    )?.sourceId;
    return {
      anchorId: sourceId || context.inspector.selectedSubgraph.id,
      anchorKind: "group",
    };
  }
  if (context.inspector.selectedNode) {
    const architecture = architectureNodeGfxData(
      context.inspector.selectedNode,
    );
    return {
      anchorId: architecture?.sourceId || context.inspector.selectedNode.id,
      anchorKind: architecture?.kind === "junction" ? "junction" : "service",
    };
  }
  return { anchorKind: "diagram" };
}

function applyArchitectureProperties(
  context: MermaidGfxActionContext,
  source: string,
  values: ReadonlyArray<{
    readonly control: MermaidArchitectureGfxControl;
    readonly value: string;
  }>,
) {
  if (context.readonly) return mermaidMessages.architectureInvalidProperties();
  const currentValues = new Map(
    architecturePropertyFields(context.visualModel, context.inspector).map(
      (field) => [field.control, field.value],
    ),
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
      const idControl = (control: MermaidArchitectureGfxControl) =>
        control === "architectureNodeId" || control === "architectureGroupId";
      return Number(idControl(left)) - Number(idControl(right));
    });
  if (!changedValues.length) return null;
  const selection = {
    edgeId: context.inspector.selectedEdge?.id,
    nodeId: context.inspector.selectedNode?.id,
    subgraphId: context.inspector.selectedSubgraph?.id,
  };
  const labels = new Map(
    architecturePropertyFields(context.visualModel, context.inspector).map(
      (field) => [field.control, field.label],
    ),
  );
  const mutation = resolveArchitectureFieldsInteraction(
    source,
    context.visualModel,
    selection,
    changedValues,
  );
  if (!mutation.changed) {
    const control = changedValues[0]?.control;
    return `${mutation.diagnostic} ${labels.get(control) ?? control ?? ""}`.trim();
  }
  const result = context.applyVisualModel(mutation.visualModel);
  if (!result.applied) {
    return result.diagnostic || mermaidMessages.architectureInvalidProperties();
  }
  const selectionAfter = architectureVisualSelectionAfter(
    mutation.visualModel,
    mutation.selectionAfter,
  );
  if (selectionAfter) {
    context.selectAfterProjection({
      editKey: selectionAfter.id,
      kind: selectionAfter.kind,
    });
  }
  return null;
}

function applyArchitectureCommentModel(
  context: MermaidGfxActionContext,
  source: string,
  mutate: (
    model: NonNullable<ReturnType<typeof parseMermaidArchitectureSource>>,
  ) => MermaidArchitectureCommandResult,
) {
  if (context.readonly) return mermaidMessages.architectureInvalidProperties();
  const mutation = resolveArchitectureCommentInteraction(
    source,
    context.visualModel,
    mutate,
  );
  if (!mutation.changed) return mutation.diagnostic;
  const result = context.applyVisualModel(mutation.visualModel);
  return result.applied
    ? null
    : result.diagnostic || mermaidMessages.architectureInvalidProperties();
}

export function architectureReactLabels() {
  return {
    add: mermaidMessages.architectureAdd(),
    apply: mermaidMessages.architectureApply(),
    addGroup: mermaidMessages.architectureAddGroup(),
    addJunction: mermaidMessages.architectureAddJunction(),
    addService: mermaidMessages.architectureAddService(),
    serviceToJunctionWarning:
      mermaidMessages.architectureServiceToJunctionWarning(),
    junctionToServiceNotice:
      mermaidMessages.architectureJunctionToServiceNotice(),
    alignColumn: mermaidMessages.architectureAlignColumn(),
    alignRow: mermaidMessages.architectureAlignRow(),
    connect: mermaidMessages.visualConnect(),
    connecting: mermaidMessages.visualConnecting(),
    connectingHint: mermaidMessages.visualConnectingHint(),
    deleteComment: mermaidMessages.architectureDeleteComment(),
    deleteAlignment: mermaidMessages.architectureDeleteAlignment(),
    invalidProperties: mermaidMessages.architectureInvalidProperties(),
    properties: mermaidMessages.architectureProperties(),
    toolbar: mermaidMessages.visualEditorLabel(),
    diagramSettings: mermaidMessages.architectureDiagramSettings(),
    accessibility: mermaidMessages.architectureAccessibility(),
    accessibilityTitle: mermaidMessages.architectureAccessibilityTitle(),
    accessibilityDescription:
      mermaidMessages.architectureAccessibilityDescription(),
    padding: mermaidMessages.architecturePadding(),
    iconSize: mermaidMessages.architectureIconSize(),
    fontSize: mermaidMessages.architectureFontSize(),
    randomize: mermaidMessages.architectureRandomize(),
    nodeSeparation: mermaidMessages.architectureNodeSeparation(),
    idealEdgeLengthMultiplier:
      mermaidMessages.architectureIdealEdgeLengthMultiplier(),
    layout: mermaidMessages.layoutLabel(),
    edgeElasticity: mermaidMessages.architectureEdgeElasticity(),
    exportMmd: mermaidMessages.mmdExport(),
    numIter: mermaidMessages.architectureNumIter(),
    seed: mermaidMessages.architectureSeed(),
  };
}

export function createArchitectureEditorProps(
  context: MermaidGfxActionContext,
  source: string,
): MermaidArchitectureEditorReactHostProps {
  const parsed = parseMermaidArchitectureSource(source);
  const projected = architectureModelGfxData(context.visualModel);
  const comments = parsed?.comments ?? projected?.comments ?? [];
  const fields = architecturePropertyFields(
    context.visualModel,
    context.inspector,
  );
  const selectedArchitectureNodes = context.selectedNodeIds.flatMap(
    (nodeId) => {
      const node = context.visualModel.nodes.find(
        (candidate) => candidate.id === nodeId,
      );
      return node && architectureNodeGfxData(node) ? [node] : [];
    },
  );
  const addGroupValidation = validateMermaidPageSelectionContainerAction(
    mermaidArchitecturePageSelectionTools.containerAction,
    context.selectedItems,
    context.visualModel,
  );
  const selectedAlignmentMatches = (
    alignment: NonNullable<typeof projected>["alignments"][number],
  ) =>
    selectedArchitectureNodes.length === context.selectedItems.length &&
    alignment.members.length === selectedArchitectureNodes.length &&
    alignment.members.every((member) =>
      selectedArchitectureNodes.some((node) => node.id === member),
    );
  const activeAlignment =
    projected?.alignments.find(
      (alignment) =>
        alignment.id === context.selectedAlignmentGuideId &&
        selectedAlignmentMatches(alignment),
    ) ?? projected?.alignments.find(selectedAlignmentMatches);
  const selectedCommentAnchor =
    context.selectedAlignmentGuideId && activeAlignment
      ? {
          anchorId: activeAlignment.id,
          anchorKind: "alignment" as const,
        }
      : selectedArchitectureAnchor(context);
  const canAddGroup = addGroupValidation.valid;
  const canAlign =
    selectedArchitectureNodes.length >= 2 &&
    selectedArchitectureNodes.length === context.selectedItems.length;
  const canConnect =
    (selectedArchitectureNodes.length === 1 ||
      selectedArchitectureNodes.length === 2) &&
    selectedArchitectureNodes.length === context.selectedItems.length;
  const selectedNodeArchitecture = context.inspector.selectedNode
    ? architectureNodeGfxData(context.inspector.selectedNode)
    : undefined;
  const selectedSubgraphArchitecture = context.inspector.selectedSubgraph
    ? architectureSubgraphGfxData(context.inspector.selectedSubgraph)
    : undefined;
  const selectedIcon = selectedNodeArchitecture?.hasIcon
    ? {
        icon: selectedNodeArchitecture.icon,
        kind: selectedNodeArchitecture.iconKind,
      }
    : selectedSubgraphArchitecture?.hasIcon
      ? { icon: selectedSubgraphArchitecture.icon, kind: "icon" as const }
      : null;
  const commentProjection = projectArchitectureComments(
    parsed,
    comments,
    context,
  );
  return {
    surface: "editor",
    actionTarget: context.actionTarget,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    accessibilityDescription: context.visualModel.accessibilityDescription,
    accessibilityTitle: context.visualModel.accessibilityTitle,
    alignDisabledReason: canAlign
      ? ""
      : selectedArchitectureNodes.length < 2
        ? mermaidMessages.flowchartSubgraphMinimum()
        : mermaidMessages.flowchartSubgraphNodesOnly(),
    canAlign,
    canDeleteAlignment: Boolean(activeAlignment),
    canAddGroup,
    addGroupDisabledReason: canAddGroup
      ? ""
      : mermaidArchitecturePageSelectionTools.containerAction.validationMessage(
          addGroupValidation.code,
        ),
    canConnect,
    connectDisabledReason: canConnect
      ? ""
      : selectedArchitectureNodes.length !== context.selectedItems.length
        ? mermaidMessages.flowchartSubgraphNodesOnly()
        : selectedArchitectureNodes.length > 2
          ? mermaidMessages.flowchartConnectExactlyTwo()
          : mermaidMessages.flowchartSingleNodeAction(),
    ...commentProjection,
    connecting: context.connecting,
    diagramTitle: context.visualModel.diagramTitle,
    diagramConfig: parsed ? mermaidArchitectureDiagramConfig(parsed) : {},
    displayOnly: context.displayOnly,
    fields,
    iconDiagnostic:
      selectedIcon &&
      !architectureIconIsResolved(selectedIcon.icon, selectedIcon.kind)
        ? mermaidMessages.architectureIconUnavailable(selectedIcon.icon)
        : "",
    labels: architectureReactLabels(),
    onAddComment: (value, anchor = selectedCommentAnchor) =>
      parsed
        ? (applyArchitectureCommentModel(context, source, (model) =>
            addMermaidArchitectureComment(model, anchor, value),
          ) ?? null)
        : mermaidMessages.architectureInvalidProperties(),
    onAddGroup: context.addContainer,
    onAddJunction: () => context.addNode("circle"),
    onAddService: () => context.addNode("subroutine"),
    onAlign: (direction) => {
      if (context.readonly) return;
      const members = activeAlignment?.members ?? context.selectedNodeIds;
      const mutation = resolveArchitectureAlignmentInteraction(
        source,
        context.visualModel,
        members,
        direction,
        activeAlignment?.id,
      );
      if (mutation.changed) context.applyVisualModel(mutation.visualModel);
    },
    onDeleteAlignment: () => {
      if (context.readonly || !activeAlignment) return;
      const mutation = resolveArchitectureAlignmentDeleteInteraction(
        source,
        context.visualModel,
        activeAlignment.id,
      );
      if (mutation.changed) context.applyVisualModel(mutation.visualModel);
    },
    onCloseSelection: context.closeInspector,
    onCommentChange: (commentId, value) =>
      parsed
        ? (applyArchitectureCommentModel(context, source, (model) =>
            updateMermaidArchitectureComment(model, commentId, value),
          ) ?? null)
        : mermaidMessages.architectureInvalidProperties(),
    onCommentDelete: (commentId) =>
      parsed
        ? (applyArchitectureCommentModel(context, source, (model) =>
            deleteMermaidArchitectureComment(model, commentId),
          ) ?? null)
        : mermaidMessages.architectureInvalidProperties(),
    onConnect: context.connect,
    onLayoutApply: (visualModel) => {
      if (context.readonly) {
        return mermaidMessages.architectureInvalidProperties();
      }
      const result = context.applyVisualModel(visualModel);
      return result.diagnostic ?? null;
    },
    onLayoutPreview: () =>
      parsed ? architectureModelToGfxVisualModel(parsed) : null,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    onDiagramSettingsApply: (values) => {
      if (context.readonly) {
        return mermaidMessages.architectureInvalidProperties();
      }
      const mutation = resolveArchitectureDiagramInteraction(
        source,
        context.visualModel,
        values,
      );
      if (!mutation.changed) return mutation.diagnostic;
      const result = context.applyVisualModel(mutation.visualModel);
      return result.applied
        ? null
        : result.diagnostic || mermaidMessages.architectureInvalidProperties();
    },
    onExportMmd: context.exportMmd,
    onPropertiesApply: (values) =>
      parsed
        ? applyArchitectureProperties(context, source, values)
        : mermaidMessages.architectureInvalidProperties(),
    onWorkareaResize: context.refreshWorkarea,
    readonly: context.readonly,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
    selectionKey:
      (context.selectedAlignmentGuideId &&
        activeAlignment &&
        `alignment:${activeAlignment.id}`) ||
      (context.inspector.selectedNode &&
        `node:${context.inspector.selectedNode.id}`) ||
      (context.inspector.selectedEdge &&
        `edge:${context.inspector.selectedEdge.id}`) ||
      (context.inspector.selectedSubgraph &&
        `subgraph:${context.inspector.selectedSubgraph.id}`) ||
      "",
    selectionCount: context.selectedItems.length,
    selectionAction: context.selectionAction,
    selectionAnchor:
      (context.selectedAlignmentGuideId && activeAlignment
        ? context.resolveVisualAnchor("alignment", activeAlignment.id)
        : null) ??
      context.selectedNodeAnchor ??
      context.selectedEdgeAnchor ??
      context.selectedSubgraphAnchor,
    selectionCommentAnchor: selectedCommentAnchor,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
  };
}
