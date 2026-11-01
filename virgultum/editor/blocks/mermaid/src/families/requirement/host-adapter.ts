// SPDX-License-Identifier: AGPL-3.0-or-later
import { Bound } from "@virgultum/global/gfx";
import { createMermaidClipboardPort } from "../../clipboard.js";
import type { ToolbarContext } from "@virgultum/shared/services";
import { mermaidMessages as m } from "../../i18n.js";
import type {
  MermaidFamilyHostAdapter,
  MermaidFamilyEdgelessToolbarContribution,
} from "../runtime/contracts.js";
import {
  gfxEditorCapabilities,
  type MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import { readRequirementProjectionModel } from "./readback.js";
import { requirementCardMetrics } from "./layout.js";
import { subscribeNativeRequirementReconnect } from "./native-reconnect.js";
import {
  createRequirementFieldConsumer,
  createRequirementDeleteConsumer,
  createRequirementObjectConsumer,
  createRequirementRelationConsumer,
  createRequirementRelationPreview,
  createRequirementDiagramConsumer,
  createRequirementPasteConsumer,
  createRequirementDuplicateConsumer,
  createRequirementCommentConsumer,
  createRequirementTitleConsumer,
  type RequirementCommandPort,
  requirementPageSelectionTools,
} from "./actions.js";
import {
  mermaidRequirementRendererToken,
  type RequirementReactHostProps,
} from "./react-host-contract.js";
import {
  resolveMermaidEdgelessSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import {
  applyMermaidVisualModelCommand,
  getMermaidVisualModelForEditing,
  getMermaidGfxNode,
  getMermaidGfxConnector,
} from "../../commands.js";
import { getMermaidBlockSource } from "../../utils.js";
import {
  beginRequirementCreationDraft,
  type RequirementCreationDraft,
} from "./creation-draft.js";
import {
  beginNativeRequirementCreation,
  previewNativeRequirement,
} from "./native-creation.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
  readMermaidGfxMeta,
} from "../../mermaid-gfx-metadata.js";
import { requirementCommentMarkers } from "./annotation-projection.js";
import { requirementReferenceMarkers } from "./reference-projection.js";

export const mermaidRequirementHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    ...gfxEditorCapabilities(resolution.visualModel, resolution.renderSurface, {
      embeddedFacadeSurface: true,
      pageSelectionTools: requirementPageSelectionTools,
      projectActions: () => null,
    }),
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        pageSelectionTools: requirementPageSelectionTools,
        renderSurface: resolution.renderSurface,
        onObjectEditIntent: (intent) => {
          if (host.getReadonly()) return false;
          host.setTransientState("requirement.pending", intent);
          return true;
        },
        projectActions: (context) => {
          const edit = host.getTransientState(
            "requirement.pending",
          ) as MermaidGfxObjectEditIntent | null;
          if (edit) {
            if (
              edit.action !== "delete" &&
              edit.action !== "duplicate" &&
              (edit.kind === "node" || edit.kind === "detail")
            )
              context.selectNode(edit.ownerId ?? edit.id);
            if (edit.action !== "delete" && edit.kind === "edge")
              context.selectEdge(edit.id);
            host.setTransientState(
              "requirement.intent",
              edit.connection ||
                edit.action === "select" ||
                edit.action === "delete"
                ? null
                : edit,
            );
            if (edit.action === "delete")
              host.setTransientState("requirement.delete", true);
            if (edit.connection)
              host.setTransientState("requirement.connection", edit.connection);
            host.setTransientState("requirement.pending", null);
          }
          const model = readRequirementProjectionModel(
            host.getSource(),
            context.visualModel,
          );
          if (!model) return null;
          const allObjects = [
            ...model.requirements,
            ...model.elements,
            ...model.relations,
          ];
          const selectedKeys = allObjects
            .filter((object) =>
              context.selectedItems.some((item) => item.editKey === object.id),
            )
            .flatMap((object) => (object.sourceKey ? [object.sourceKey] : []));
          const port = {
            getSource: host.getSource,
            getReadonly: () =>
              host.getReadonly() || context.readonly || displayOnly,
            getVisualModel: () =>
              context.getVisualModel?.() ?? context.visualModel,
            applyVisualModel: context.applyVisualModel,
            selectAfterProjection: context.selectAfterProjection,
            selectManyAfterProjection: context.selectManyAfterProjection,
            getSelectedItems: () =>
              context.selectedItems.filter(
                (item) => item.kind === "node" || item.kind === "edge",
              ) as { kind: "node" | "edge"; editKey: string }[],
          };
          const activeDraft = host.getTransientState(
            "requirement.creationDraft",
          ) as RequirementCreationDraft | null;
          if (
            activeDraft &&
            (context.readonly || displayOnly || !activeDraft.valid())
          )
            activeDraft.cancel();
          const requestDelete = () => {
            host.setTransientState("requirement.intent", null);
            host.setTransientState("requirement.delete", true);
            context.refreshWorkarea();
          };
          host.setSelectionAction(
            selectedKeys.length
              ? {
                  label: m.visualDelete(),
                  disabled: context.readonly || displayOnly,
                  onSelect: requestDelete,
                }
              : null,
          );
          const node = context.inspector.selectedNode,
            edge = context.inspector.selectedEdge;
          const selected = node
            ? [...model.requirements, ...model.elements].find(
                (n) => n.id === node.id,
              )
            : model.relations.find((e) => e.id === edge?.id);
          const intent = host.getTransientState(
            "requirement.intent",
          ) as MermaidGfxObjectEditIntent | null;
          if (
            !edit &&
            intent &&
            !context.selectedItems.some(
              (item) => item.editKey === (intent.ownerId ?? intent.id),
            )
          )
            host.setTransientState("requirement.intent", null);
          const props: RequirementReactHostProps = {
            surface: "editor",
            model,
            sourceBasis: host.getSource(),
            referenceMarkers: requirementReferenceMarkers(model, (kind, id) => {
              const bounds =
                kind === "node" &&
                context.resolveVisualBounds?.("node", id ?? "");
              return bounds
                ? { left: bounds.left, top: bounds.top }
                : context.resolveVisualAnchor(kind, id);
            }),
            commentMarkers: requirementCommentMarkers(
              model,
              context.resolveVisualAnchor,
              (key) =>
                context.visualModel.nodes
                  .flatMap((node) => node.details ?? [])
                  .find((detail) => detail.sourceKey === key)?.id,
              context.visualModel.nodes[0]
                ? (context.resolveVisualBounds?.(
                    "node",
                    context.visualModel.nodes[0].id,
                  )?.width ?? context.visualModel.nodes[0].width) /
                    context.visualModel.nodes[0].width
                : 1,
            ),
            onComment: createRequirementCommentConsumer(port),
            onTitle: createRequirementTitleConsumer(port),
            clipboard: context.clipboard,
            ownerIdentity: context.viewportIdentity ?? host,
            onPaste: createRequirementPasteConsumer(port),
            onDuplicate: createRequirementDuplicateConsumer(port),
            copyGeometry: [...model.requirements, ...model.elements]
              .filter((object) => selectedKeys.includes(object.sourceKey ?? ""))
              .flatMap(
                (object) =>
                  context.visualModel.nodes.find(
                    (node) => node.id === object.id,
                  ) ?? [],
              ),
            selectedKey: selected?.sourceKey,
            typography: node
              ? requirementCardMetrics(node).typography
              : undefined,
            selectedKeys,
            deleteRequested:
              host.getTransientState("requirement.delete") === true,
            selectionKey: `${node ? "node" : "edge"}:${selected?.sourceKey ?? ""}`,
            intent: host.getTransientState(
              "requirement.intent",
            ) as MermaidGfxObjectEditIntent | null,
            readonly: context.readonly,
            displayOnly,
            embedded: context.embedded,
            actionTarget: context.actionTarget,
            workarea: context.workarea,
            workareaFooter: context.workareaFooter,
            pageViewport: context.pageViewport,
            history: context.history,
            selectionAction: context.selectionAction,
            selectedAnchor:
              (intent?.kind === "detail"
                ? context.resolveVisualAnchor(
                    "detail",
                    context.visualModel.nodes
                      .flatMap((node) => node.details ?? [])
                      .find((detail) => detail.sourceKey === intent.id)?.id,
                    true,
                  )
                : null) ??
              (node
                ? context.resolveVisualAnchor("node", node.id, true)
                : edge
                  ? context.resolveVisualAnchor("edge", edge.id, true)
                  : null) ??
              context.selectedNodeAnchor ??
              context.selectedEdgeAnchor,
            portal: !context.embedded,
            connecting: context.connecting,
            connectionProposal: host.getTransientState(
              "requirement.connection",
            ) as RequirementReactHostProps["connectionProposal"],
            onSaveRelation: createRequirementRelationConsumer(port),
            previewRelation: createRequirementRelationPreview(
              port,
              context.previewVisualModel,
            ),
            canConnect: Boolean(node),
            onAdd: (kind) => {
              if (port.getReadonly()) return;
              activeDraft?.cancel();
              const basis = host.getSource(),
                previous = context.selectedItems[0];
              context.beginNodePlacement((placement) => {
                if (port.getReadonly() || host.getSource() !== basis) return;
                let draft: RequirementCreationDraft | null = null;
                draft = beginRequirementCreationDraft(
                  {
                    ...port,
                    command: createRequirementObjectConsumer(port),
                    previewVisualModel: context.previewVisualModel,
                    mountShapeDraft: context.mountShapeDraft,
                    subscribeInvalidation: context.subscribeDraftInvalidation,
                    clearSelection: context.closeInspector,
                    restoreSelection: () => {
                      if (previous)
                        context.selectAfterProjection(previous, {
                          focus: false,
                        });
                    },
                    selectAfterPreview: (id) =>
                      context.selectAfterProjection({
                        kind: "node",
                        editKey: id,
                      }),
                    renderActions: (actions) =>
                      context.reactHost?.renderFamilyEditor(
                        mermaidRequirementRendererToken,
                        { surface: "label-actions", ...actions },
                      ) ?? undefined,
                    finish: () => {
                      if (
                        host.getTransientState("requirement.creationDraft") ===
                        draft
                      )
                        host.setTransientState(
                          "requirement.creationDraft",
                          null,
                        );
                      context.refreshWorkarea();
                      requestAnimationFrame(() => {
                        if (
                          !host.getTransientState(
                            "requirement.creationDraft",
                          ) &&
                          (!document.activeElement ||
                            document.activeElement === document.body)
                        )
                          context
                            .resolveReturnFocusTarget()
                            ?.focus({ preventScroll: true });
                      });
                    },
                  },
                  kind,
                  placement,
                );
                if (draft)
                  host.setTransientState("requirement.creationDraft", draft);
              });
            },
            onCreate: createRequirementObjectConsumer(port),
            onDiagramSettings: createRequirementDiagramConsumer(port),
            onOpen: () => {
              if (selected) {
                host.setTransientState("requirement.intent", {
                  kind: node ? "node" : "edge",
                  id: selected.id,
                  action: "edit",
                });
                context.refreshWorkarea();
              }
            },
            onClose: (edgeId) => {
              host.setTransientState("requirement.connection", null);
              host.setTransientState("requirement.intent", null);
              host.setTransientState("requirement.delete", false);
              if (edgeId) context.selectEdge(edgeId);
              context.refreshWorkarea();
              // Floating must dispose the old focus scope before focus returns.
              requestAnimationFrame(() => {
                if (!host.getTransientState("requirement.intent"))
                  context
                    .resolveReturnFocusTarget()
                    ?.focus({ preventScroll: true });
              });
            },
            onSave: createRequirementFieldConsumer(port),
            onRequestDelete: requestDelete,
            onDelete: createRequirementDeleteConsumer(port),
            onWorkareaResize: context.refreshWorkarea,
            onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
            resolveReturnFocusTarget: context.resolveReturnFocusTarget,
          };
          return {
            body:
              context.reactHost?.renderFamilyEditor(
                mermaidRequirementRendererToken,
                props,
              ) ?? null,
            actions: {
              actions: [],
              portal: !context.embedded,
              selectionAction: host.getSelectionAction(),
            },
          };
        },
      }),
  }),
};

function nativeControls(context: ToolbarContext) {
  const state = resolveMermaidEdgelessSelection(context);
  const react = context.std.getOptional(MermaidFamilyReactHostIdentifier);
  if (
    !state?.visualModel ||
    !react ||
    state.diagramType !== "requirementDiagram"
  )
    return null;
  const visual = state.visualModel;
  const model = readRequirementProjectionModel(
    getMermaidBlockSource(state.owner.props),
    visual,
  );
  if (!model) return null;
  const nodeIds = state.selectedModels.map(readMermaidGfxNodeId),
    edgeIds = state.selectedModels.map(readMermaidGfxEdgeId);
  const selected =
    [...model.requirements, ...model.elements].find((n) =>
      nodeIds.includes(n.id),
    ) ?? model.relations.find((e) => edgeIds.includes(e.id));
  const titleElement =
    state.selectedModels.length === 1 &&
    readMermaidGfxMeta(state.selectedModels[0], "mermaidRole") ===
      "mermaid-diagram-title"
      ? state.selectedModels[0]
      : null;
  const anchor =
    selected || titleElement
      ? (() => {
          const element = state.selectedModels[0];
          if (!element?.xywh) return null;
          const bound = Bound.deserialize(element.xywh),
            rect = context.gfx.viewport.boundingClientRect;
          const [left, top] = context.gfx.viewport.toViewCoord(
            bound.maxX,
            bound.y,
          );
          return { left: left + rect.left, top: top + rect.top };
        })()
      : null;
  const port: RequirementCommandPort = {
    clearSelection: () =>
      context.gfx.selection.set({ editing: false, elements: [] }),
    getSource: () => getMermaidBlockSource(state.owner.props),
    getReadonly: () =>
      context.store.readonly ||
      state.owner.isLocked() ||
      context.store.getBlock(state.owner.id)?.model !== state.owner ||
      !context.host.isConnected,
    getVisualModel: () =>
      getMermaidVisualModelForEditing(context.std, state.owner) ?? visual,
    selectAfterProjection: (item) => {
      const element =
        item.kind === "node"
          ? getMermaidGfxNode(context.store, state.owner, item.editKey)
          : getMermaidGfxConnector(context.store, state.owner, item.editKey);
      if (element)
        context.gfx.selection.set({ editing: false, elements: [element.id] });
    },
    selectManyAfterProjection: (items) => {
      const elements = items.flatMap(
        (item) =>
          getMermaidGfxNode(context.store, state.owner, item.editKey)?.id ?? [],
      );
      context.gfx.selection.set({ editing: false, elements });
    },
    getSelectedItems: () =>
      context.gfx.selection.selectedElements.flatMap<{
        kind: "node" | "edge";
        editKey: string;
      }>((element) => {
        const node = readMermaidGfxNodeId(element),
          edge = readMermaidGfxEdgeId(element);
        return node
          ? [{ kind: "node" as const, editKey: node }]
          : edge
            ? [{ kind: "edge" as const, editKey: edge }]
            : [];
      }),
    applyVisualModel: (next, options) => {
      let feedback: { applied: boolean; diagnostic?: string } = {
        applied: false,
      };
      const applied = runMermaidEdgelessMutation(context, state.owner, () => {
        const [ok, result] = context.command.exec(
          applyMermaidVisualModelCommand,
          { model: state.owner, visualModel: next, ...options },
        );
        feedback = {
          applied: Boolean(ok && result?.applied),
          diagnostic: result?.diagnostic,
        };
        return feedback.applied;
      });
      return { ...feedback, applied };
    },
  };
  const selectedNode =
    selected &&
    port.getVisualModel().nodes.find((node) => node.id === selected.id);
  return react.toolbarControl(mermaidRequirementRendererToken, {
    surface: "controls",
    model,
    sourceBasis: model.sourceDocument!.source,
    markersInClientSpace: true,
    referenceMarkers: requirementReferenceMarkers(model, (kind, id) => {
      const element =
        kind === "node"
          ? getMermaidGfxNode(context.store, state.owner, id ?? "")
          : state.owner;
      if (!element?.xywh) return null;
      const bound = Bound.deserialize(element.xywh),
        rect = context.gfx.viewport.boundingClientRect;
      const [left, top] = context.gfx.viewport.toViewCoord(bound.x, bound.y);
      return { left: left + rect.left, top: top + rect.top };
    }),
    commentMarkers: requirementCommentMarkers(
      model,
      (kind, id) => {
        const element =
          kind === "diagram"
            ? state.owner
            : kind === "node"
              ? getMermaidGfxNode(context.store, state.owner, id ?? "")
              : kind === "edge"
                ? getMermaidGfxConnector(context.store, state.owner, id ?? "")
                : state.owner.childIds
                    .map((key) => state.owner.surface?.getElementById(key))
                    .find(
                      (element) => element?.yMap.get("mermaidDetailId") === id,
                    );
        if (!element?.xywh) return null;
        if (
          kind === "edge" &&
          "labelXYWH" in element &&
          Array.isArray(element.labelXYWH)
        ) {
          const [x, y, w, h] = element.labelXYWH as number[],
            rect = context.gfx.viewport.boundingClientRect;
          const [left, top] = context.gfx.viewport.toViewCoord(
            x + w / 2,
            y + h / 2,
          );
          return { left: left + rect.left, top: top + rect.top };
        }
        const bound = Bound.deserialize(element.xywh),
          rect = context.gfx.viewport.boundingClientRect;
        const [left, top] = context.gfx.viewport.toViewCoord(
          kind === "diagram" ? bound.x : bound.maxX,
          bound.y,
        );
        return { left: left + rect.left, top: top + rect.top };
      },
      (key) =>
        visual.nodes
          .flatMap((node) => node.details ?? [])
          .find((detail) => detail.sourceKey === key)?.id,
      context.gfx.viewport.zoom,
    ),
    onComment: createRequirementCommentConsumer(port),
    clipboard: createMermaidClipboardPort(context.std, () => {
      const current = context.gfx.selection.selectedElements;
      return (
        current.length > 0 &&
        current.every(
          (element) =>
            state.owner.childIds.includes(element.id) &&
            Boolean(readMermaidGfxNodeId(element)),
        )
      );
    }),
    ownerIdentity: state.owner,
    onPaste: createRequirementPasteConsumer(port),
    onDuplicate: createRequirementDuplicateConsumer(port),
    copyGeometry: [...model.requirements, ...model.elements]
      .filter((object) => nodeIds.includes(object.id))
      .flatMap(
        (object) => visual.nodes.find((node) => node.id === object.id) ?? [],
      ),
    selectedKey: selected?.sourceKey ?? titleElement?.id,
    titleSelected: Boolean(titleElement),
    onTitle: createRequirementTitleConsumer(port),
    typography: selectedNode
      ? requirementCardMetrics(selectedNode).typography
      : undefined,
    selectedKeys: [...model.requirements, ...model.elements, ...model.relations]
      .filter(
        (object) => nodeIds.includes(object.id) || edgeIds.includes(object.id),
      )
      .flatMap((object) => (object.sourceKey ? [object.sourceKey] : [])),
    deleteRequested: false,
    selectionKey: selected?.sourceKey ?? titleElement?.id ?? "",
    intent: null,
    readonly: context.readonly || port.getReadonly(),
    displayOnly: false,
    embedded: false,
    workarea: null,
    workareaFooter: null,
    selectedAnchor: anchor,
    portal: true,
    connecting: false,
    connectionProposal: null,
    onSaveRelation: createRequirementRelationConsumer(port),
    previewRelation: createRequirementRelationPreview(port, (candidate) =>
      previewNativeRequirement(context, state, port, candidate),
    ),
    canConnect: model.requirements.length + model.elements.length > 0,
    onAdd: (kind) => beginNativeRequirementCreation(context, state, port, kind),
    onCreate: createRequirementObjectConsumer(port),
    onDiagramSettings: createRequirementDiagramConsumer(port),
    onOpen: () => undefined,
    onClose: (edgeId) => {
      const edge =
        edgeId && getMermaidGfxConnector(context.store, state.owner, edgeId);
      if (edge)
        context.gfx.selection.set({ editing: false, elements: [edge.id] });
      context.host.focus();
    },
    onSave: createRequirementFieldConsumer(port),
    onDelete: createRequirementDeleteConsumer(port),
    onRequestDelete: () => undefined,
    subscribeEditIntent: (listener) => {
      const handler = (event: Event) => {
        const intent = (event as CustomEvent<MermaidGfxObjectEditIntent>)
          .detail;
        if (
          [...model.requirements, ...model.elements, ...model.relations].some(
            (n) => n.id === (intent.ownerId ?? intent.id),
          ) ||
          (state.owner.childIds.includes(intent.id) &&
            readMermaidGfxMeta(
              state.owner.surface?.getElementById(intent.id),
              "mermaidRole",
            ) === "mermaid-diagram-title")
        )
          listener(intent);
      };
      context.host.addEventListener("mermaid-gfx-object-edit", handler);
      const stopReconnect = subscribeNativeRequirementReconnect(
        context,
        state,
        port,
        listener,
      );
      return () => {
        stopReconnect();
        context.host.removeEventListener("mermaid-gfx-object-edit", handler);
      };
    },
    onWorkareaResize: () => undefined,
    resolveReturnFocusTarget: () => context.host,
  });
}
export const requirementEdgelessToolbar: MermaidFamilyEdgelessToolbarContribution =
  {
    // Generic add/connect/reconnect actions remain on the existing native toolbar.
    actions: [
      {
        id: "requirement.properties",
        label: m.displayEdit(),
        control: nativeControls,
      },
    ],
  };
