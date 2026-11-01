// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import type { ToolbarControl } from "@virgultum/shared/services";

import {
  ActionPlacement,
  editorMessage,
  EditorI18nProvider,
  type ToolbarContext,
} from "@virgultum/shared/services";

import {
  applyMermaidVisualModelCommand,
  getMermaidGfxConnector,
  getMermaidGfxNode,
} from "../../commands.js";
import {
  resolveMermaidEdgelessSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import {
  flowchartNodeData,
  flowchartNodeLink,
  setFlowchartNodeLink,
  withFlowchartNodeMarkdown,
} from "../../engine/flowchart-node.js";
import { mermaidMessages } from "../../i18n.js";
import { MERMAID_FLOWCHART_SHAPES } from "../../mermaid-block-constants.js";
import { mermaidShapeSyntaxLabel } from "../../mermaid-block-shape-helpers.js";
import {
  readMermaidGfxEdgeId,
  readMermaidGfxNodeId,
  readMermaidGfxSubgraphId,
} from "../../mermaid-gfx-metadata.js";
import { setMermaidVisualNodeShape } from "../../mermaid-visual-model-operations.js";
import {
  createMermaidGfxEdgelessToolbarConfig,
  revealNativeMermaidNode,
} from "../runtime/gfx-edgeless-toolbar.js";
import {
  addMermaidGfxEdgeCommand,
  addMermaidGfxNodeCommand,
} from "../runtime/gfx-commands.js";
import { FLOWCHART_ACTION_IDS } from "./action-catalog.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import {
  mermaidFlowchartRendererToken,
  type MermaidFlowchartMetadataReactHostProps,
} from "./react-host-contract.js";
import {
  addFlowchartComment,
  deleteFlowchartComment,
  flowchartCommentAnchorLabel,
  flowchartComments,
  updateFlowchartComment,
  type MermaidFlowchartCommentAnchor,
} from "./comments.js";
import { withFlowchartAccessibility } from "./accessibility.js";
import type {
  MermaidVisualEdgeLinkType,
  MermaidVisualEdgeStyle,
  MermaidVisualSemanticStyle,
} from "../runtime/gfx-model.js";
import {
  readFlowchartEdgeSemanticStyle,
  readFlowchartNodeSemanticStyle,
} from "./gfx-style-projection.js";
import {
  canReparentFlowchartGfxSubgraph,
  renameFlowchartGfxEdge,
  renameFlowchartGfxSubgraph,
  reorderFlowchartGfxSubgraph,
  reparentFlowchartGfxNodes,
  reparentFlowchartGfxSubgraph,
} from "./gfx-operations.js";
import {
  setMermaidVisualEdgeLinkType,
  setMermaidVisualEdgeStyle,
  setMermaidVisualEdgeStyleStatement,
  setMermaidVisualNodeStyleClass,
} from "./model-operations.js";
import type { MermaidGfxFamilyHookRegistration } from "../runtime/gfx-family-hooks-contract.js";
import {
  readFlowchartTextFormat,
  setFlowchartTextFormat,
} from "./text-formatting.js";
import { layoutMeasuredFlowchart } from "./layout.js";

function textSelection(context: ToolbarContext) {
  return context
    .getSurfaceModels()
    .flatMap<{ kind: "node" | "edge" | "subgraph"; editKey: string }>(
      (element) => {
        const node = readMermaidGfxNodeId(element);
        const edge = readMermaidGfxEdgeId(element);
        const subgraph = readMermaidGfxSubgraphId(element);
        return node
          ? [{ kind: "node" as const, editKey: node }]
          : edge
            ? [{ kind: "edge" as const, editKey: edge }]
            : subgraph
              ? [{ kind: "subgraph" as const, editKey: subgraph }]
              : [];
      },
    );
}

function flowchartState(
  context: ToolbarContext,
  registration: MermaidGfxFamilyHookRegistration,
) {
  const state = resolveMermaidEdgelessSelection(context);
  return state?.projection &&
    state.visualModel &&
    registration.owns(state.visualModel)
    ? {
        ...state,
        projection: state.projection,
        visualModel: state.visualModel,
      }
    : null;
}

function selectedFlowchartNode(
  context: ToolbarContext,
  registration: MermaidGfxFamilyHookRegistration,
) {
  const state = resolveMermaidEdgelessSelection(context);
  const nodeIds = context
    .getSurfaceModels()
    .map(readMermaidGfxNodeId)
    .filter(Boolean);
  const nodeId = nodeIds.length === 1 ? nodeIds[0] : "";
  const node =
    state?.visualModel && nodeId
      ? state.visualModel.nodes.find((candidate) => candidate.id === nodeId)
      : undefined;
  return state?.projection &&
    state.visualModel &&
    registration.owns(state.visualModel) &&
    node
    ? { ...state, node, nodeId, visualModel: state.visualModel }
    : null;
}

function selectedFlowchartEdge(
  context: ToolbarContext,
  registration: MermaidGfxFamilyHookRegistration,
) {
  const state = resolveMermaidEdgelessSelection(context);
  const edgeIds = context
    .getSurfaceModels()
    .map(readMermaidGfxEdgeId)
    .filter(Boolean);
  const edgeId = edgeIds.length === 1 ? edgeIds[0] : "";
  const edge =
    state?.visualModel && edgeId
      ? state.visualModel.edges.find((candidate) => candidate.id === edgeId)
      : undefined;
  return state?.projection &&
    state.visualModel &&
    registration.owns(state.visualModel) &&
    edge
    ? { ...state, edge, edgeId, visualModel: state.visualModel }
    : null;
}

function selectedFlowchartSubgraph(
  context: ToolbarContext,
  registration: MermaidGfxFamilyHookRegistration,
) {
  const state = resolveMermaidEdgelessSelection(context);
  const subgraphIds = context
    .getSurfaceModels()
    .map(readMermaidGfxSubgraphId)
    .filter(Boolean);
  const subgraphId = subgraphIds.length === 1 ? subgraphIds[0] : "";
  const subgraph =
    state?.visualModel && subgraphId
      ? state.visualModel.subgraphs?.find(
          (candidate) => candidate.id === subgraphId,
        )
      : undefined;
  return state?.projection &&
    state.visualModel &&
    registration.owns(state.visualModel) &&
    subgraph
    ? { ...state, subgraph, subgraphId, visualModel: state.visualModel }
    : null;
}

function applyNodeModel(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof selectedFlowchartNode>>,
  visualModel: typeof state.visualModel,
) {
  return runMermaidEdgelessMutation(
    context,
    state.owner,
    () =>
      context.command.exec(applyMermaidVisualModelCommand, {
        model: state.owner,
        visualModel,
      })[1]?.applied === true,
  );
}

function applyEdgeModel(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof selectedFlowchartEdge>>,
  visualModel: typeof state.visualModel,
) {
  return runMermaidEdgelessMutation(
    context,
    state.owner,
    () =>
      context.command.exec(applyMermaidVisualModelCommand, {
        model: state.owner,
        visualModel,
      })[1]?.applied === true,
  );
}

function applySubgraphModel(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof selectedFlowchartSubgraph>>,
  visualModel: typeof state.visualModel,
) {
  return runMermaidEdgelessMutation(
    context,
    state.owner,
    () =>
      context.command.exec(applyMermaidVisualModelCommand, {
        model: state.owner,
        visualModel,
      })[1]?.applied === true,
  );
}

function applyFlowchartModel(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof flowchartState>>,
  visualModel: typeof state.visualModel,
) {
  return runMermaidEdgelessMutation(
    context,
    state.owner,
    () =>
      context.command.exec(applyMermaidVisualModelCommand, {
        model: state.owner,
        visualModel,
      })[1]?.applied === true,
  );
}

function addFlowchartNodeWithShape(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof flowchartState>>,
  shape: (typeof MERMAID_FLOWCHART_SHAPES)[number],
) {
  if (!state.projection) return;
  let nodeId = "";
  const applied = runMermaidEdgelessMutation(context, state.owner, () => {
    const [ok, result] = context.command.exec(addMermaidGfxNodeCommand, {
      model: state.owner,
      shape,
    });
    nodeId = result?.nodeId ?? "";
    return ok;
  });
  if (!applied || !nodeId) return;
  const node = getMermaidGfxNode(context.store, state.projection.model, nodeId);
  if (node) {
    context.gfx.selection.set({ editing: false, elements: [node.id] });
    revealNativeMermaidNode(context, node.xywh);
  }
}

function connectFlowchartNode(
  context: ToolbarContext,
  state: NonNullable<ReturnType<typeof selectedFlowchartNode>>,
  targetNodeId: string,
) {
  if (!state.projection) return;
  let edgeId = "";
  const applied = runMermaidEdgelessMutation(context, state.owner, () => {
    const [ok, result] = context.command.exec(addMermaidGfxEdgeCommand, {
      model: state.owner,
      sourceNodeId: state.nodeId,
      targetNodeId,
    });
    edgeId = result?.edgeId ?? "";
    return ok;
  });
  if (!applied || !edgeId) return;
  const connector = getMermaidGfxConnector(
    context.store,
    state.projection.model,
    edgeId,
  );
  if (connector) {
    context.gfx.selection.set({
      editing: false,
      elements: [connector.id],
    });
  }
}

function selectedCommentAnchor(
  context: ToolbarContext,
): MermaidFlowchartCommentAnchor {
  const selected = context.getSurfaceModels();
  const edgeId = selected.map(readMermaidGfxEdgeId).find(Boolean);
  if (edgeId) return { anchorId: edgeId, anchorKind: "edge" };
  const subgraphId = selected.map(readMermaidGfxSubgraphId).find(Boolean);
  if (subgraphId) return { anchorId: subgraphId, anchorKind: "subgraph" };
  const nodeId = selected.map(readMermaidGfxNodeId).find(Boolean);
  return nodeId
    ? { anchorId: nodeId, anchorKind: "node" }
    : { anchorKind: "diagram" };
}

function metadataProjection(
  context: ToolbarContext,
  registration: MermaidGfxFamilyHookRegistration,
  kind: MermaidFlowchartMetadataReactHostProps["kind"],
) {
  const state = flowchartState(context, registration);
  const reactHost = context.std.getOptional(MermaidFamilyReactHostIdentifier);
  if (!state || !reactHost) return null;
  const anchor = selectedCommentAnchor(context);
  const selectionKey = `${anchor.anchorKind}:${anchor.anchorId ?? "diagram"}`;
  const visibleComments = flowchartComments(state.visualModel).filter(
    (comment) =>
      comment.anchorKind === anchor.anchorKind &&
      comment.anchorId === anchor.anchorId,
  );
  const apply = (next: typeof state.visualModel | null) => {
    if (!next || context.readonly)
      return mermaidMessages.visualMutationSourceRejected("Flowchart");
    return applyFlowchartModel(context, state, next)
      ? null
      : mermaidMessages.visualMutationSourceRejected("Flowchart");
  };
  return reactHost.toolbarControl(mermaidFlowchartRendererToken, {
    accessibilityDescription: state.visualModel.accessibilityDescription,
    accessibilityTitle: state.visualModel.accessibilityTitle,
    comments: visibleComments.map((comment) => ({
      anchor: flowchartCommentAnchorLabel(state.visualModel, comment),
      anchorId: comment.anchorId,
      anchorKind: comment.anchorKind,
      id: comment.id,
      text: comment.line.replace(/^%%\s*/, ""),
    })),
    kind,
    labels: {
      accessibility: mermaidMessages.visualAccessibility(),
      accessibilityDescription:
        mermaidMessages.visualAccessibilityDescription(),
      accessibilityTitle: mermaidMessages.visualAccessibilityTitle(),
      deleteComment: mermaidMessages.visualDeleteComment(),
    },
    onAddComment: (value) =>
      apply(addFlowchartComment(state.visualModel, anchor, value)),
    onAccessibilityApply: (values) =>
      apply(withFlowchartAccessibility(state.visualModel, values)),
    onCommentChange: (commentId, value) =>
      apply(updateFlowchartComment(state.visualModel, commentId, value)),
    onCommentDelete: (commentId) =>
      apply(deleteFlowchartComment(state.visualModel, commentId)),
    readonly: context.readonly,
    selectionKey,
  });
}

const styleOptions: ReadonlyArray<{
  label: () => string;
  value: MermaidVisualSemanticStyle | "";
}> = [
  { label: mermaidMessages.optionDefault, value: "" },
  { label: mermaidMessages.optionNeutral, value: "neutral" },
  { label: mermaidMessages.optionAccent, value: "accent" },
  { label: mermaidMessages.optionProcessing, value: "processing" },
  { label: mermaidMessages.optionSuccess, value: "success" },
  { label: mermaidMessages.optionWarning, value: "warning" },
  { label: mermaidMessages.optionError, value: "error" },
];

const edgeStyleOptions: ReadonlyArray<{
  label: () => string;
  value: MermaidVisualEdgeStyle;
}> = [
  { label: mermaidMessages.optionSolid, value: "solid" },
  { label: mermaidMessages.optionDotted, value: "dotted" },
  { label: mermaidMessages.optionThick, value: "thick" },
];

const edgeLinkTypeOptions: ReadonlyArray<{
  label: () => string;
  value: MermaidVisualEdgeLinkType;
}> = [
  { label: mermaidMessages.optionArrow, value: "arrow" },
  { label: mermaidMessages.optionOpen, value: "open" },
  { label: mermaidMessages.optionBidirectional, value: "bidirectional" },
  { label: mermaidMessages.shapeCircle, value: "circle" },
  { label: mermaidMessages.optionCross, value: "cross" },
  { label: mermaidMessages.optionDottedArrow, value: "dotted" },
  { label: mermaidMessages.optionThickArrow, value: "thick" },
];

function selectControl<T extends string>({
  currentValue,
  onPick,
  options,
}: {
  icon?: MyoxusIconExportName;
  currentValue: T | "";
  label: string;
  onPick: (value: T) => void;
  options: ReadonlyArray<{ label: string; value: T }>;
}): ToolbarControl {
  return {
    type: "choice",
    value: currentValue,
    options,
    change: (value: string) => onPick(value as T),
  };
}

export function createFlowchartEdgelessToolbarConfig(
  registration: MermaidGfxFamilyHookRegistration,
) {
  const base = createMermaidGfxEdgelessToolbarConfig(registration, {
    addNode: FLOWCHART_ACTION_IDS.addNode,
    addSubgraph: FLOWCHART_ACTION_IDS.addSubgraph,
    connect: FLOWCHART_ACTION_IDS.connect,
    deleteSelection: FLOWCHART_ACTION_IDS.deleteSelection,
  });
  const secondaryActions = new Set([
    FLOWCHART_ACTION_IDS.more,
    "mermaid-flowchart.markdown",
    "mermaid-flowchart.link",
    "mermaid-flowchart.node-group",
    "mermaid-flowchart.subgraph-direction",
    "mermaid-flowchart.subgraph-parent",
    "mermaid-flowchart.subgraph-up",
    "mermaid-flowchart.subgraph-down",
  ]);
  return {
    ...base,
    actions: [
      ...base.actions
        .filter((action) => action.id !== FLOWCHART_ACTION_IDS.connect)
        .map((action) => ({
          ...action,
          ...(action.id === FLOWCHART_ACTION_IDS.addNode && "run" in action
            ? {
                run(context: ToolbarContext) {
                  action.run(context);
                  const node = context.getSurfaceModels()[0];
                  if (node && readMermaidGfxNodeId(node))
                    revealNativeMermaidNode(context, node.xywh);
                },
              }
            : {}),
          ...(action.id === FLOWCHART_ACTION_IDS.deleteSelection
            ? { placement: ActionPlacement.End }
            : {}),
          ...(action.id === FLOWCHART_ACTION_IDS.addNode
            ? {
                icon: "PlusIcon" as const,
                showLabel: false,
                label: editorMessage(
                  "com.myoxus.editor.mermaid.visual-add-node",
                  "Add node",
                ),
              }
            : action.id === FLOWCHART_ACTION_IDS.addSubgraph
              ? {
                  icon: "GroupIcon" as const,
                  showLabel: false,
                  label: editorMessage(
                    "com.myoxus.editor.mermaid.visual-add-subgraph",
                    "Add group",
                  ),
                }
              : {}),
        })),
      {
        id: FLOWCHART_ACTION_IDS.connect,
        label: mermaidMessages.visualConnect(),
        when: (context: ToolbarContext) => {
          const state = selectedFlowchartNode(context, registration);
          return Boolean(
            !context.readonly && state && state.visualModel.nodes.length > 1,
          );
        },
        control(context: ToolbarContext) {
          const state = selectedFlowchartNode(context, registration);
          if (!state) return null;
          return selectControl({
            currentValue: "",
            icon: "LinkIcon" as const,
            label: mermaidMessages.visualConnect(),
            options: state.visualModel.nodes
              .filter((node) => node.id !== state.nodeId)
              .map((node) => ({
                label: node.label || node.id,
                value: node.id,
              })),
            onPick: (targetId) => {
              connectFlowchartNode(context, state, targetId);
            },
          });
        },
      },
      {
        id: FLOWCHART_ACTION_IDS.comments,
        label: mermaidMessages.visualComments(),
        when: (context: ToolbarContext) =>
          Boolean(flowchartState(context, registration)),
        control: (context: ToolbarContext) =>
          metadataProjection(context, registration, "comments"),
      },
      {
        id: FLOWCHART_ACTION_IDS.more,
        label: mermaidMessages.visualMoreActions(),
        when: (context: ToolbarContext) =>
          Boolean(flowchartState(context, registration)),
        control: (context: ToolbarContext) =>
          metadataProjection(context, registration, "more"),
      },
      {
        id: FLOWCHART_ACTION_IDS.shapes,
        label: editorMessage("com.myoxus.editor.toolbar.shape", "Shape"),
        when: (context: ToolbarContext) =>
          !context.readonly && Boolean(flowchartState(context, registration)),
        control(context: ToolbarContext) {
          const selectedNode = selectedFlowchartNode(context, registration);
          const flowchart = flowchartState(context, registration);
          if (!selectedNode && !flowchart) return null;
          const label = context.std
            .get(EditorI18nProvider)
            .translate(
              editorMessage("com.myoxus.editor.toolbar.shape", "Shape"),
            );
          return selectControl({
            currentValue: selectedNode?.node.shape ?? "",
            icon: "ShapesIcon" as const,
            options: MERMAID_FLOWCHART_SHAPES.map((shape) => ({
              label: mermaidShapeSyntaxLabel(shape),
              value: shape,
            })),
            label,
            onPick: (shape) => {
              if (selectedNode) {
                applyNodeModel(
                  context,
                  selectedNode,
                  setMermaidVisualNodeShape(
                    selectedNode.visualModel,
                    selectedNode.nodeId,
                    shape,
                  ),
                );
              } else if (flowchart) {
                addFlowchartNodeWithShape(context, flowchart, shape);
              }
            },
          });
        },
      },
      {
        id: FLOWCHART_ACTION_IDS.appearance,
        label: editorMessage("com.myoxus.editor.toolbar.style", "Style"),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(
            selectedFlowchartNode(context, registration) ??
            selectedFlowchartEdge(context, registration),
          ),
        control(context: ToolbarContext) {
          const nodeState = selectedFlowchartNode(context, registration);
          const edgeState = selectedFlowchartEdge(context, registration);
          if (!nodeState && !edgeState) return null;
          const currentStyle = nodeState
            ? readFlowchartNodeSemanticStyle(
                nodeState.visualModel,
                nodeState.node,
              )
            : readFlowchartEdgeSemanticStyle(
                edgeState!.visualModel,
                edgeState!.edge,
              );
          const label = context.std
            .get(EditorI18nProvider)
            .translate(
              editorMessage("com.myoxus.editor.toolbar.style", "Style"),
            );
          return selectControl({
            currentValue: currentStyle,
            icon: "PaletteIcon" as const,
            options: styleOptions.map((option) => ({
              label: option.label(),
              value: option.value,
            })),
            label,
            onPick: (style) => {
              if (nodeState) {
                applyNodeModel(
                  context,
                  nodeState,
                  setMermaidVisualNodeStyleClass(
                    nodeState.visualModel,
                    nodeState.nodeId,
                    style,
                  ),
                );
              } else if (edgeState) {
                applyEdgeModel(
                  context,
                  edgeState,
                  setMermaidVisualEdgeStyleStatement(
                    edgeState.visualModel,
                    edgeState.edgeId,
                    style,
                  ),
                );
              }
            },
          });
        },
      },
      {
        id: "mermaid-flowchart.text-formatting",
        label: mermaidMessages.architectureFontSize(),
        when: (context: ToolbarContext) =>
          Boolean(
            flowchartState(context, registration) &&
            textSelection(context).length,
          ),
        control(context: ToolbarContext) {
          const state = flowchartState(context, registration);
          const host = context.std.getOptional(
            MermaidFamilyReactHostIdentifier,
          );
          const value =
            state &&
            readFlowchartTextFormat(state.visualModel, textSelection(context));
          if (!state || !host || !value) return null;
          return host.toolbarControl(mermaidFlowchartRendererToken, {
            kind: "typography",
            value,
            readonly: context.readonly,
            onChange: (patch) => {
              const current = flowchartState(context, registration);
              if (current && !context.readonly)
                applyFlowchartModel(
                  context,
                  current,
                  setFlowchartTextFormat(
                    current.visualModel,
                    textSelection(context),
                    patch,
                  ),
                );
            },
          });
        },
      },
      {
        id: "mermaid-flowchart.layout",
        label: editorMessage(
          "com.myoxus.editor.mermaid.class-apply-layout",
          "Apply layout",
        ),
        icon: "LayoutIcon" as const,
        placement: ActionPlacement.More,
        when: (context: ToolbarContext) =>
          !context.readonly && Boolean(flowchartState(context, registration)),
        run(context: ToolbarContext) {
          const state = flowchartState(context, registration);
          if (state)
            applyFlowchartModel(
              context,
              state,
              layoutMeasuredFlowchart(state.visualModel),
            );
        },
      },
      {
        id: "mermaid-flowchart.markdown",
        label: editorMessage(
          "com.myoxus.shortcutsTitle.markdownSyntax",
          "Markdown syntax",
        ),
        active: (context: ToolbarContext) => {
          const state = selectedFlowchartNode(context, registration);
          return Boolean(state && flowchartNodeData(state.node).markdown);
        },
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartNode(context, registration)),
        run(context: ToolbarContext) {
          const state = selectedFlowchartNode(context, registration);
          if (!state) return;
          applyNodeModel(context, state, {
            ...state.visualModel,
            nodes: state.visualModel.nodes.map((node) =>
              node.id === state.nodeId
                ? withFlowchartNodeMarkdown(
                    node,
                    !flowchartNodeData(node).markdown,
                  )
                : node,
            ),
          });
        },
      },
      {
        id: "mermaid-flowchart.link",
        label: editorMessage("com.myoxus.editor.keyboard.link", "Link"),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartNode(context, registration)),
        icon: "LinkIcon" as const,
        control(context: ToolbarContext) {
          const state = selectedFlowchartNode(context, registration);
          if (!state) return null;
          let draft =
            flowchartNodeLink(state.visualModel, state.nodeId)?.url ?? "";
          return {
            type: "text" as const,
            value: draft,
            change: (value: string) => {
              draft = value;
            },
            submit: () => {
              const next = setFlowchartNodeLink(
                state.visualModel,
                state.nodeId,
                draft,
              );
              if (!next)
                return editorMessage(
                  "com.myoxus.editor.embed.valid-url-hint",
                  "Please enter a valid URL",
                );
              applyNodeModel(context, state, next);
              return null;
            },
          };
        },
      },
      {
        id: "mermaid-flowchart.node-group",
        label: editorMessage("com.myoxus.keyboardShortcuts.group", "Group"),
        when: (context: ToolbarContext) => {
          const state = selectedFlowchartNode(context, registration);
          return Boolean(
            !context.readonly &&
            state &&
            (state.visualModel.subgraphs?.length ?? 0) > 0,
          );
        },
        control(context: ToolbarContext) {
          const state = selectedFlowchartNode(context, registration);
          if (!state) return null;
          const i18n = context.std.get(EditorI18nProvider);
          const label = i18n.translate(
            editorMessage("com.myoxus.keyboardShortcuts.group", "Group"),
          );
          const noGrouping = i18n.translate(
            editorMessage(
              "com.myoxus.page.display.grouping.no-grouping",
              "No grouping",
            ),
          );
          const current =
            state.visualModel.subgraphs?.find((subgraph) =>
              subgraph.nodeIds.includes(state.nodeId),
            )?.id ?? "";
          return selectControl({
            currentValue: current,
            label,
            options: [
              { label: noGrouping, value: "" },
              ...(state.visualModel.subgraphs ?? []).map((subgraph) => ({
                label: subgraph.title,
                value: subgraph.id,
              })),
            ],
            onPick: (subgraphId) =>
              applyNodeModel(
                context,
                state,
                reparentFlowchartGfxNodes(
                  state.visualModel,
                  [state.nodeId],
                  subgraphId,
                ),
              ),
          });
        },
      },
      {
        id: "mermaid-flowchart.subgraph-title",
        label: mermaidMessages.selectedSubgraphTitle(),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartSubgraph(context, registration)),
        icon: "EditIcon" as const,
        control(context: ToolbarContext) {
          const state = selectedFlowchartSubgraph(context, registration);
          if (!state) return null;
          let draft = state.subgraph.title;
          return {
            type: "text" as const,
            value: draft,
            change: (value: string) => {
              draft = value;
            },
            submit: () => {
              applySubgraphModel(
                context,
                state,
                renameFlowchartGfxSubgraph(
                  state.visualModel,
                  state.subgraphId,
                  draft,
                ),
              );
              return null;
            },
          };
        },
      },
      {
        id: "mermaid-flowchart.subgraph-direction",
        label: editorMessage(
          "com.myoxus.documentGraph.direction.label",
          "Direction",
        ),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartSubgraph(context, registration)),
        control(context: ToolbarContext) {
          const state = selectedFlowchartSubgraph(context, registration);
          if (!state) return null;
          const label = context.std
            .get(EditorI18nProvider)
            .translate(
              editorMessage(
                "com.myoxus.documentGraph.direction.label",
                "Direction",
              ),
            );
          return selectControl({
            currentValue:
              state.subgraph.direction ?? state.visualModel.direction,
            label,
            options: ["TD", "TB", "BT", "LR", "RL"].map((value) => ({
              label: value,
              value: value as "TD" | "TB" | "BT" | "LR" | "RL",
            })),
            onPick: (direction) =>
              applySubgraphModel(context, state, {
                ...state.visualModel,
                subgraphs: (state.visualModel.subgraphs ?? []).map(
                  (subgraph) =>
                    subgraph.id === state.subgraphId
                      ? { ...subgraph, direction }
                      : subgraph,
                ),
              }),
          });
        },
      },
      {
        id: "mermaid-flowchart.subgraph-parent",
        label: editorMessage("com.myoxus.keyboardShortcuts.group", "Group"),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartSubgraph(context, registration)),
        control(context: ToolbarContext) {
          const state = selectedFlowchartSubgraph(context, registration);
          if (!state) return null;
          const i18n = context.std.get(EditorI18nProvider);
          const label = i18n.translate(
            editorMessage("com.myoxus.keyboardShortcuts.group", "Group"),
          );
          const noGrouping = i18n.translate(
            editorMessage(
              "com.myoxus.page.display.grouping.no-grouping",
              "No grouping",
            ),
          );
          return selectControl({
            currentValue: state.subgraph.parentId ?? "",
            label,
            options: [
              { label: noGrouping, value: "" },
              ...(state.visualModel.subgraphs ?? [])
                .filter((subgraph) =>
                  canReparentFlowchartGfxSubgraph(
                    state.visualModel,
                    state.subgraphId,
                    subgraph.id,
                  ),
                )
                .map((subgraph) => ({
                  label: subgraph.title,
                  value: subgraph.id,
                })),
            ],
            onPick: (parentId) =>
              applySubgraphModel(
                context,
                state,
                reparentFlowchartGfxSubgraph(
                  state.visualModel,
                  state.subgraphId,
                  parentId,
                ),
              ),
          });
        },
      },
      {
        id: "mermaid-flowchart.subgraph-up",
        label: mermaidMessages.visualMoveUp(),
        showLabel: true,
        when: (context: ToolbarContext) => {
          const state = selectedFlowchartSubgraph(context, registration);
          if (context.readonly || !state) return false;
          const siblings = (state.visualModel.subgraphs ?? []).filter(
            (subgraph) => subgraph.parentId === state.subgraph.parentId,
          );
          return siblings.findIndex(({ id }) => id === state.subgraphId) > 0;
        },
        run(context: ToolbarContext) {
          const state = selectedFlowchartSubgraph(context, registration);
          if (!state) return;
          applySubgraphModel(
            context,
            state,
            reorderFlowchartGfxSubgraph(
              state.visualModel,
              state.subgraphId,
              -1,
            ),
          );
        },
      },
      {
        id: "mermaid-flowchart.subgraph-down",
        label: mermaidMessages.visualMoveDown(),
        showLabel: true,
        when: (context: ToolbarContext) => {
          const state = selectedFlowchartSubgraph(context, registration);
          if (context.readonly || !state) return false;
          const siblings = (state.visualModel.subgraphs ?? []).filter(
            (subgraph) => subgraph.parentId === state.subgraph.parentId,
          );
          const index = siblings.findIndex(({ id }) => id === state.subgraphId);
          return index >= 0 && index < siblings.length - 1;
        },
        run(context: ToolbarContext) {
          const state = selectedFlowchartSubgraph(context, registration);
          if (!state) return;
          applySubgraphModel(
            context,
            state,
            reorderFlowchartGfxSubgraph(state.visualModel, state.subgraphId, 1),
          );
        },
      },
      {
        id: "mermaid-flowchart.edge-label",
        label: mermaidMessages.selectedEdgeLabel(),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartEdge(context, registration)),
        icon: "EditIcon" as const,
        control(context: ToolbarContext) {
          const state = selectedFlowchartEdge(context, registration);
          if (!state) return null;
          let draft = state.edge.label;
          return {
            type: "text" as const,
            value: draft,
            change: (value: string) => {
              draft = value;
            },
            submit: () => {
              applyEdgeModel(
                context,
                state,
                renameFlowchartGfxEdge(state.visualModel, state.edgeId, draft),
              );
              return null;
            },
          };
        },
      },
      {
        id: "mermaid-flowchart.edge-style",
        label: mermaidMessages.selectedEdgeStyle(),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartEdge(context, registration)),
        control(context: ToolbarContext) {
          const state = selectedFlowchartEdge(context, registration);
          if (!state) return null;
          return selectControl({
            currentValue: state.edge.style,
            icon: "TextIcon" as const,
            label: mermaidMessages.selectedEdgeStyle(),
            options: edgeStyleOptions.map((option) => ({
              label: option.label(),
              value: option.value,
            })),
            onPick: (style) =>
              applyEdgeModel(
                context,
                state,
                setMermaidVisualEdgeStyle(
                  state.visualModel,
                  state.edgeId,
                  style,
                ),
              ),
          });
        },
      },
      {
        id: "mermaid-flowchart.edge-type",
        label: mermaidMessages.selectedEdgeType(),
        when: (context: ToolbarContext) =>
          !context.readonly &&
          Boolean(selectedFlowchartEdge(context, registration)),
        control(context: ToolbarContext) {
          const state = selectedFlowchartEdge(context, registration);
          if (!state) return null;
          return selectControl({
            currentValue: state.edge.linkType ?? "arrow",
            icon: "LinkIcon" as const,
            label: mermaidMessages.selectedEdgeType(),
            options: edgeLinkTypeOptions.map((option) => ({
              label: option.label(),
              value: option.value,
            })),
            onPick: (linkType) =>
              applyEdgeModel(
                context,
                state,
                setMermaidVisualEdgeLinkType(
                  state.visualModel,
                  state.edgeId,
                  linkType,
                ),
              ),
          });
        },
      },
    ].map((action) =>
      secondaryActions.has(action.id)
        ? { ...action, placement: ActionPlacement.More }
        : action,
    ),
  };
}
