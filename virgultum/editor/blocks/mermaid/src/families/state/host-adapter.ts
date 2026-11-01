// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  MermaidHostProjectionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import type {
  StateReactHostProps,
  StateSelection,
} from "./react-host-contract.js";
import { mermaidStateRendererToken } from "./react-host-contract.js";
import { stateProjectionBinding } from "./gfx-data.js";
import { stateCommentMarkers } from "./annotation-projection.js";
import { previewMermaidGfxModel } from "../runtime/gfx-preview.js";
import {
  readStateProjectionModel,
  reconcileStateVisual,
} from "./source-application.js";
import { stateModelToVisual } from "./visual-model.js";
import {
  runStateCommand,
  stateCommandReflowScopes,
  statePageSelectionTools,
  STATE_PARENT_ACTIONS,
  STATE_PARENT_ACTION_LABELS,
  type StateParentAction,
} from "./actions.js";
import {
  readStateConfig,
  stateRecordGroup,
  stateImpact,
  deleteStateSelection,
  deleteStateComposite,
  deleteStatePseudostate,
  stateCompositeSelectionAllowed,
} from "../../engine/state/index.js";

function stateSelection(
  visual: MermaidGfxActionContext["visualModel"],
  kind: string,
  key: string,
  ownerKey?: string,
): StateSelection | null {
  if (kind === "detail")
    return {
      kind: "description",
      key:
        visual.nodes.flatMap((n) => n.details ?? []).find((d) => d.id === key)
          ?.sourceKey ?? key,
      ownerKey,
    };
  if (kind === "edge")
    return visual.edges.some((e) => e.id === key)
      ? { kind: "transition", key }
      : null;
  if (kind === "subgraph") return { kind: "composite", key };
  const binding = stateProjectionBinding(
    visual.nodes.find((n) => n.id === key) ?? {},
  );
  return binding
    ? {
        kind:
          binding.role === "note"
            ? "note"
            : binding.role === "region"
              ? "region"
              : "state",
        key,
        ownerKey:
          binding.role === "region"
            ? visual.subgraphs?.find(
                (g) => stateProjectionBinding(g)?.sourceId === binding.parentId,
              )?.id
            : ownerKey,
      }
    : null;
}
export function stateSelectionImpact(
  model: StateReactHostProps["model"],
  item: StateSelection,
) {
  if (item.kind === "state") {
    const node = model.states.find((n) => n.sourceKey === item.key);
    return node && (node.kind === "start" || node.kind === "end")
      ? deleteStatePseudostate(model, item.key, "all").impact
      : deleteStateSelection(model, [item.key]).impact;
  }
  if (item.kind === "composite")
    return deleteStateComposite(model, item.key, { children: "delete" }).impact;
  const group = stateRecordGroup(model, item.key);
  return stateImpact(model, group?.records ?? []);
}
export type StateCommandPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidGfxActionContext["visualModel"];
  applyVisualModel: MermaidGfxActionContext["applyVisualModel"];
  selectAfterProjection: MermaidGfxActionContext["selectAfterProjection"];
  getPlacement?: () => { centerX: number; centerY: number } | null;
  clearPlacement?: () => void;
  clearPreview?: () => void;
  onDescriptionIntent?: (intent: MermaidGfxObjectEditIntent) => void;
};
/** Page, embedded and native controls commit through this one checked owner port. */
export function createStateCommandConsumer(
  port: StateCommandPort,
): StateReactHostProps["onCommand"] {
  return (name, args, basis, requestedPlacement) => {
    if (port.getReadonly())
      return { changed: false, diagnostic: mermaidMessages.ganttReadOnly() };
    const current = port.getSource();
    if (current !== basis)
      return {
        changed: false,
        diagnostic: mermaidMessages.stateSourceConflict(),
      };
    const active = readStateProjectionModel(current, port.getVisualModel());
    if (!active)
      return {
        changed: false,
        diagnostic: mermaidMessages.classPatchRejected(),
      };
    const result = runStateCommand(active, name, args);
    const appearance =
      name === "editStateAppearance"
        ? (args[0] as { layout?: boolean; direction?: string })
        : null;
    const forceLayout = Boolean(
      appearance?.layout ||
      (appearance?.direction && appearance.direction !== active.direction),
    );
    if (result.status === "rejected" || (!result.changed && !forceLayout))
      return {
        changed: false,
        diagnostic: result.diagnostic,
        impact: result.impact,
      };
    const visual = reconcileStateVisual(
      stateModelToVisual(result.model),
      port.getVisualModel(),
      !forceLayout,
      stateCommandReflowScopes(active, name, args),
    );
    const placement = requestedPlacement ?? port.getPlacement?.();
    const sourceObject = [
      ...result.model.states,
      ...result.model.composites,
    ].find(
      (n) => n.sourceKey === result.selection || n.id === result.selection,
    );
    const key = sourceObject?.sourceKey ?? result.selection;
    if (
      ["addState", "addStatePseudostate", "addStateNote"].includes(name) &&
      placement
    ) {
      const added = visual.nodes.find((n) => n.id === key);
      if (added) {
        added.x = placement.centerX - added.width / 2;
        added.y = placement.centerY - added.height / 2;
      }
    }
    port.clearPreview?.();
    const committed = port.applyVisualModel(visual, {
      preserveSourceBytes: true,
      ...(result.changed
        ? { sourceWrite: { baseSource: current, source: result.source } }
        : {}),
    });
    if (!committed.applied)
      return {
        changed: false,
        diagnostic:
          committed.diagnostic ?? mermaidMessages.classPatchRejected(),
      };
    if (key) {
      const description = result.model.states
        .flatMap((n) => (n.descriptions ?? []).map((d) => ({ d, n })))
        .find((v) => v.d.id === key);
      const owner = description?.n.sourceKey ?? key;
      const kind = visual.nodes.some((n) => n.id === owner)
        ? "node"
        : visual.edges.some((e) => e.id === owner)
          ? "edge"
          : visual.subgraphs?.some((g) => g.id === owner)
            ? "subgraph"
            : null;
      if (kind && owner) port.selectAfterProjection({ editKey: owner, kind });
      if (description)
        port.onDescriptionIntent?.({ kind: "detail", id: key, ownerId: owner });
    }
    port.clearPlacement?.();
    return {
      changed: true,
      sourceBasis: result.source,
      selection: key,
      impact: result.impact,
    };
  };
}
export function createStateEditorProps(
  context: MermaidGfxActionContext,
  host: MermaidHostProjectionContext,
): StateReactHostProps | null {
  const model = readStateProjectionModel(host.getSource(), context.visualModel);
  if (!model) return null;
  const intent = host.getTransientState(
    "state.editIntent",
  ) as MermaidGfxObjectEditIntent | null;
  const parentIntent = host.getTransientState(
    "state.parentIntent",
  ) as StateParentAction | null;
  const retained = host.getTransientState("state.selectedDescription") as {
    key: string;
    ownerKey: string;
  } | null;
  const descriptionSelected =
    retained &&
    context.selectedItems.length === 1 &&
    context.selectedItems[0]?.editKey === retained.ownerKey &&
    model.states.some((n) =>
      n.descriptions?.some((d) => d.id === retained.key),
    );
  if (retained && !descriptionSelected && context.selectedItems.length)
    host.setTransientState("state.selectedDescription", null);
  const item = intent
    ? { kind: intent.kind, editKey: intent.id }
    : context.selectedItems.length === 1
      ? context.selectedItems[0]
      : null;
  const selected = descriptionSelected
    ? { kind: "description" as const, ...retained }
    : item
      ? stateSelection(
          context.visualModel,
          item.kind,
          item.editKey,
          intent?.ownerId,
        )
      : null;
  const onEditIntent = (value: MermaidGfxObjectEditIntent | null) => {
    const closingFocus = document.activeElement;
    host.setTransientState("state.editIntent", value);
    if (value?.kind === "detail" && value.ownerId)
      host.setTransientState("state.selectedDescription", {
        key: value.id,
        ownerKey: value.ownerId,
      });
    else if (value) host.setTransientState("state.selectedDescription", null);
    context.refreshWorkarea();
    if (!value)
      requestAnimationFrame(() => {
        if (
          host.getTransientState("state.editIntent") ||
          host.getTransientState("state.parentIntent")
        )
          return;
        // Closing a portal may release focus to body. A later pointer/keyboard
        // action in another control owns its new focus; do not reclaim it.
        if (
          document.activeElement !== closingFocus &&
          document.activeElement !== document.body
        )
          return;
        context.resolveReturnFocusTarget()?.focus({ preventScroll: true });
      });
  };
  const selectedKeys = context.selectedItems.map((i) => i.editKey);
  const clearPreview = () => {
    const dispose = host.getTransientState("state.preview") as
      (() => void) | null;
    host.setTransientState("state.preview", null);
    dispose?.();
  };
  const anchorKind =
    selected?.kind === "description"
      ? "detail"
      : selected?.kind === "composite"
        ? "subgraph"
        : selected?.kind === "transition"
          ? "edge"
          : "node";
  const toClient = (anchor: { left: number; top: number } | null) => {
    const rect = context
      .resolveReturnFocusTarget()
      ?.closest(".myoxus-mermaid-gfx-viewport")
      ?.getBoundingClientRect();
    return anchor && rect
      ? {
          left: Math.min(
            rect.right,
            Math.max(rect.left, anchor.left + rect.left),
          ),
          top: Math.min(rect.bottom, Math.max(rect.top, anchor.top + rect.top)),
        }
      : null;
  };
  return {
    config: readStateConfig(model.sourceDocument).config,
    surface: "editor",
    model,
    sourceBasis: model.sourceDocument.source,
    selected,
    selectedKeys:
      selected?.kind === "description" ? [selected.key] : selectedKeys,
    selectedAnchor:
      (selected
        ? context.resolveVisualAnchor(anchorKind, selected.key, true)
        : null) ??
      intent?.anchor ??
      context.selectedNodeAnchor ??
      context.selectedEdgeAnchor ??
      context.selectedSubgraphAnchor,
    intent,
    parentIntent,
    groupAllowed:
      stateCompositeSelectionAllowed(model, selectedKeys) &&
      (statePageSelectionTools.containerAction?.validate({
        items: context.selectedItems,
        visualModel: context.visualModel,
      }).valid ??
        false),
    readonly: context.readonly || context.displayOnly,
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    placement: host.getTransientState("state.placement") as {
      centerX: number;
      centerY: number;
    } | null,
    commentMarkers: stateCommentMarkers(model, context.resolveVisualAnchor),
    getImpact: (item) => stateSelectionImpact(model, item),
    resolveDescriptionAnchor: (key) =>
      toClient(context.resolveVisualAnchor("detail", key, true)),
    onCommand: createStateCommandConsumer({
      getSource: host.getSource,
      getReadonly: () =>
        host.getReadonly() || context.readonly || context.displayOnly,
      getVisualModel: () => context.visualModel,
      applyVisualModel: context.applyVisualModel,
      selectAfterProjection: context.selectAfterProjection,
      getPlacement: () =>
        host.getTransientState("state.placement") as {
          centerX: number;
          centerY: number;
        } | null,
      clearPlacement: () => host.setTransientState("state.placement", null),
      clearPreview,
      onDescriptionIntent: (value) => {
        host.setTransientState("state.selectedDescription", {
          key: value.id,
          ownerKey: value.ownerId,
        });
        host.setTransientState("state.editIntent", value);
      },
    }),
    previewCommand: (name, args, basis) => {
      clearPreview();
      if (basis !== host.getSource() || host.getReadonly() || context.readonly)
        return {
          feedback: {
            changed: false,
            diagnostic: mermaidMessages.stateSourceConflict(),
          },
          dispose: () => {},
        };
      const result = runStateCommand(model, name, args);
      const dispose =
        result.status !== "rejected" && result.changed
          ? (context.previewVisualModel?.(
              reconcileStateVisual(
                stateModelToVisual(result.model),
                context.visualModel,
                true,
                stateCommandReflowScopes(model, name, args),
              ),
            ) ?? (() => {}))
          : () => {};
      const ownedDispose = () => {
        if (host.getTransientState("state.preview") === ownedDispose)
          host.setTransientState("state.preview", null);
        dispose();
      };
      host.setTransientState("state.preview", ownedDispose);
      return {
        feedback: {
          changed: result.changed,
          diagnostic: result.diagnostic,
          impact: result.impact,
        },
        dispose: ownedDispose,
      };
    },
    onParentIntent: (value) => {
      // This is also the handoff to a local comment marker. Its own control
      // takes focus; only explicit draft cancellation returns to the canvas.
      host.setTransientState("state.editIntent", null);
      host.setTransientState("state.parentIntent", value);
      if (value === "addState") {
        host.setTransientState("state.parentIntent", null);
        context.beginNodePlacement((point) => {
          host.setTransientState("state.placement", point);
          host.setTransientState("state.parentIntent", value);
          context.refreshWorkarea();
        });
      } else context.refreshWorkarea();
    },
    onEditIntent,
    onCloseSelection: () => {
      onEditIntent(null);
      context.closeInspector();
    },
    onWorkareaResize: context.refreshWorkarea,
    onEmbeddedActionsInsetChange: context.onEmbeddedActionsInsetChange,
    resolveReturnFocusTarget: context.resolveReturnFocusTarget,
  };
}
/** One typed contribution supplies local controls for all GFX consumers. */
export const mermaidStateHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: resolution.renderSurface,
    pageSelectionTools: statePageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: resolution.renderSurface,
        pageSelectionTools: statePageSelectionTools,
        onContainerActionIntent: () => {
          if (host.getReadonly()) return false;
          host.setTransientState("state.editIntent", null);
          host.setTransientState("state.pendingEditIntent", null);
          host.setTransientState("state.parentIntent", "group");
          return true;
        },
        resolveDetailVisibilityTarget: () => {
          const edit = (host.getTransientState("state.pendingEditIntent") ??
            host.getTransientState(
              "state.editIntent",
            )) as MermaidGfxObjectEditIntent | null;
          const selected = host.getTransientState(
            "state.selectedDescription",
          ) as { key: string; ownerKey: string } | null;
          return edit?.kind === "detail" && edit.ownerId
            ? { ownerId: edit.ownerId, detailId: edit.id }
            : selected
              ? { ownerId: selected.ownerKey, detailId: selected.key }
              : null;
        },
        onObjectEditIntent: (intent) => {
          if (host.getReadonly()) return false;
          host.setTransientState(
            "state.parentIntent",
            intent.action === "delete" ? "deleteSelection" : null,
          );
          host.setTransientState(
            "state.pendingEditIntent",
            intent.action === "delete" ? null : intent,
          );
          if (intent.action === "delete")
            host.setTransientState("state.editIntent", null);
          return true;
        },
        projectActions: (context) => {
          const edit = host.getTransientState(
            "state.pendingEditIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (edit) {
            if (edit.kind === "node" || edit.kind === "detail")
              context.selectNode(edit.ownerId ?? edit.id);
            else if (edit.kind === "edge") context.selectEdge(edit.id);
            else if (edit.kind === "subgraph") context.selectContainer(edit.id);
            host.setTransientState(
              "state.selectedDescription",
              edit.kind === "detail" && edit.ownerId
                ? { key: edit.id, ownerKey: edit.ownerId }
                : null,
            );
            host.setTransientState(
              "state.editIntent",
              edit.action === "select" ? null : edit,
            );
            host.setTransientState("state.pendingEditIntent", null);
          }
          const active = host.getTransientState(
            "state.editIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (
            !edit &&
            active &&
            !context.selectedItems.some(
              (i) => i.editKey === (active.ownerId ?? active.id),
            )
          )
            host.setTransientState("state.editIntent", null);
          const props = createStateEditorProps(context, host);
          host.setSelectionAction(
            context.selectedItems.length
              ? {
                  label: mermaidMessages.visualDelete(),
                  disabled: context.readonly,
                  onSelect: () => {
                    host.setTransientState(
                      "state.parentIntent",
                      "deleteSelection",
                    );
                    context.refreshWorkarea();
                  },
                }
              : null,
          );
          if (!props) return null;
          const body = context.reactHost?.renderFamilyEditor(
            mermaidStateRendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions:
                    displayOnly || context.embedded
                      ? []
                      : STATE_PARENT_ACTIONS.map((id) => ({
                          id: `state.${id}`,
                          label: STATE_PARENT_ACTION_LABELS[id](),
                          disabled: context.readonly && id !== "data",
                        })),
                  portal: !context.embedded,
                  selectionAction: host.getSelectionAction(),
                },
              }
            : null;
        },
      }),
  }),
  projectPreview: (visual, source) =>
    mermaidStateHostAdapter.projectGfx({
      visualModel: visual,
      source,
      diagramType: visual.diagramType,
      renderSurface: "core-facade",
    }),
};

import { mermaidMessages } from "../../i18n.js";
import type { MermaidFamilyHostAdapter } from "../runtime/contracts.js";
import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import type { ToolbarContext } from "@virgultum/shared/services";
import { Bound } from "@virgultum/global/gfx";
import {
  resolveMermaidEdgelessSelection,
  resolveMermaidEdgelessOwnerSelection,
  runMermaidEdgelessMutation,
} from "../../edgeless-toolbar/selection-context.js";
import {
  applyMermaidVisualModelCommand,
  getMermaidVisualModelForEditing,
  getMermaidGfxNode,
  getMermaidGfxConnector,
  getMermaidGfxSubgraph,
} from "../../commands.js";
import {
  readMermaidGfxNodeId,
  readMermaidGfxEdgeId,
  readMermaidGfxSubgraphId,
  readMermaidGfxMeta,
} from "../../mermaid-gfx-metadata.js";
import { getMermaidBlockSource } from "../../utils.js";
import { MermaidFamilyReactHostIdentifier } from "../runtime/react-host.js";
import { MERMAID_GFX_TITLE_ROLE } from "../runtime/gfx-element-roles.js";
import {
  MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  type MermaidFamilyEdgelessToolbarContribution,
  type MermaidPageSelectionItem,
} from "../runtime/contracts.js";
const nativeStatePreviews = new WeakMap<object, () => void>();
function nativeStateProps(context: ToolbarContext): StateReactHostProps | null {
  const state = resolveMermaidEdgelessSelection(context);
  if (
    !state?.visualModel ||
    !["stateDiagram", "stateDiagram-v2"].includes(state.diagramType)
  )
    return null;
  const source = getMermaidBlockSource(state.owner.props),
    visualModel = state.visualModel;
  const model = readStateProjectionModel(source, visualModel);
  if (!model) return null;
  const items = state.selectedModels.flatMap<MermaidPageSelectionItem>(
    (element) => {
      const node = readMermaidGfxNodeId(element),
        edge = readMermaidGfxEdgeId(element),
        group = readMermaidGfxSubgraphId(element);
      return node
        ? [{ kind: "node", editKey: node }]
        : edge
          ? [{ kind: "edge", editKey: edge }]
          : group
            ? [{ kind: "subgraph", editKey: group }]
            : [];
    },
  );
  const unique = [
    ...new Map(items.map((i) => [`${i.kind}:${i.editKey}`, i])).values(),
  ];
  const sole =
    state.selectedModels.length === 1 ? state.selectedModels[0] : null;
  const detail = sole
    ? readMermaidGfxMeta(sole, "mermaidDetailSourceKey") ||
      readMermaidGfxMeta(sole, "mermaidDetailId")
    : "";
  const description = model.states
    .flatMap((n) => (n.descriptions ?? []).map((d) => ({ n, d })))
    .find((v) => v.d.id === detail);
  const selected: StateSelection | null =
    sole && readMermaidGfxMeta(sole, "mermaidRole") === MERMAID_GFX_TITLE_ROLE
      ? { kind: "title", key: sole.id }
      : description
        ? {
            kind: "description",
            key: detail,
            ownerKey: description.n.sourceKey,
          }
        : unique.length === 1
          ? stateSelection(visualModel, unique[0]!.kind, unique[0]!.editKey)
          : null;
  let placement: { centerX: number; centerY: number } | null = null;
  const clearPreview = () => {
    const dispose = nativeStatePreviews.get(state.owner);
    nativeStatePreviews.delete(state.owner);
    dispose?.();
  };
  const resolveAnchor: MermaidGfxActionContext["resolveVisualAnchor"] = (
    kind,
    key,
  ) => {
    const element =
      kind === "detail"
        ? state.owner.childIds
            .map((id) => state.owner.surface?.getElementById(id))
            .find(
              (child) => readMermaidGfxMeta(child, "mermaidDetailId") === key,
            )
        : kind === "node"
          ? getMermaidGfxNode(context.store, state.owner, key ?? "")
          : kind === "edge"
            ? getMermaidGfxConnector(context.store, state.owner, key ?? "")
            : kind === "subgraph"
              ? getMermaidGfxSubgraph(context.store, state.owner, key ?? "")
              : state.owner;
    if (!element?.xywh) return null;
    const bound = Bound.deserialize(element.xywh),
      rect = context.gfx.viewport.boundingClientRect;
    const [left, top] = context.gfx.viewport.toViewCoord(bound.maxX, bound.y);
    // Keep local controls attached to the visible part of the rendered object.
    return {
      left: Math.min(rect.right, Math.max(rect.left, left + rect.left)),
      top: Math.min(rect.bottom, Math.max(rect.top, top + rect.top)),
    };
  };
  const commandPort: StateCommandPort = {
    getSource: () => getMermaidBlockSource(state.owner.props),
    getReadonly: () => context.readonly || context.store.readonly,
    getVisualModel: () =>
      getMermaidVisualModelForEditing(context.std, state.owner) ?? visualModel,
    getPlacement: () => placement,
    clearPlacement: () => {
      placement = null;
    },
    clearPreview,
    applyVisualModel: (visual, options) => {
      let feedback: { applied: boolean; diagnostic?: string } = {
        applied: false,
      };
      const applied = runMermaidEdgelessMutation(context, state.owner, () => {
        const [ok, result] = context.command.exec(
          applyMermaidVisualModelCommand,
          {
            model: state.owner,
            visualModel: visual,
            sourceWrite: options?.sourceWrite,
          },
        );
        feedback = {
          applied: Boolean(ok && result?.applied),
          diagnostic: result?.diagnostic,
        };
        return feedback.applied;
      });
      return { ...feedback, applied };
    },
    selectAfterProjection: (value) => {
      const element =
        value.kind === "node"
          ? getMermaidGfxNode(context.store, state.owner, value.editKey)
          : value.kind === "edge"
            ? getMermaidGfxConnector(context.store, state.owner, value.editKey)
            : getMermaidGfxSubgraph(context.store, state.owner, value.editKey);
      if (element)
        context.gfx.selection.set({ editing: false, elements: [element.id] });
    },
    onDescriptionIntent: (value) => {
      const element = state.owner.childIds
        .map((id) => state.owner.surface?.getElementById(id))
        .find(
          (child) =>
            readMermaidGfxMeta(child, "mermaidDetailSourceKey") === value.id,
        );
      if (element)
        context.gfx.selection.set({ editing: false, elements: [element.id] });
    },
  };
  return {
    surface: "controls",
    model,
    config: readStateConfig(model.sourceDocument).config,
    sourceBasis: source,
    selected,
    selectedKeys:
      selected?.kind === "title"
        ? [selected.key]
        : description
          ? [detail]
          : unique.map((i) => i.editKey),
    selectedAnchor: null,
    intent: null,
    parentIntent: null,
    groupAllowed:
      !description &&
      stateCompositeSelectionAllowed(
        model,
        unique.map((i) => i.editKey),
      ) &&
      (statePageSelectionTools.containerAction?.validate({
        items: unique,
        visualModel,
      }).valid ??
        false),
    readonly: context.readonly,
    displayOnly: false,
    embedded: false,
    embeddedEditing: false,
    workarea: null,
    workareaFooter: null,
    markersInClientSpace: true,
    commentMarkers: stateCommentMarkers(model, resolveAnchor),
    resolveDescriptionAnchor: (key) => resolveAnchor("detail", key),
    getImpact: (item) => stateSelectionImpact(model, item),
    onCommand: createStateCommandConsumer(commandPort),
    previewCommand: (name, args, basis) => {
      clearPreview();
      if (commandPort.getReadonly() || commandPort.getSource() !== basis)
        return {
          feedback: {
            changed: false,
            diagnostic: mermaidMessages.stateSourceConflict(),
          },
          dispose: () => {},
        };
      const active = readStateProjectionModel(
        basis,
        commandPort.getVisualModel(),
      );
      if (!active)
        return {
          feedback: {
            changed: false,
            diagnostic: mermaidMessages.classPatchRejected(),
          },
          dispose: () => {},
        };
      const result = runStateCommand(active, name, args);
      if (!result.changed || result.status === "rejected")
        return {
          feedback: {
            changed: false,
            diagnostic: result.diagnostic,
            impact: result.impact,
          },
          dispose: () => {},
        };
      const stored = commandPort.getVisualModel(),
        first = stored.nodes.find((n) =>
          getMermaidGfxNode(context.store, state.owner, n.id),
        ),
        element =
          first && getMermaidGfxNode(context.store, state.owner, first.id),
        surface = state.owner.surface;
      if (!surface) throw new Error("Missing native GFX Surface");
      const bound = Bound.deserialize(element?.xywh ?? state.owner.xywh);
      const dispose = previewMermaidGfxModel(
        reconcileStateVisual(
          stateModelToVisual(result.model),
          stored,
          true,
          stateCommandReflowScopes(active, name, args),
        ),
        {
          surface,
          creator: state.owner,
          viewport: context.gfx.viewport,
          origin: new Bound(
            bound.x - (first?.x ?? 0),
            bound.y - (first?.y ?? 0),
            bound.w,
            bound.h,
          ),
          elements: state.owner.childIds.flatMap((id) => {
            const e = surface.getElementById(id);
            return e &&
              "stash" in e &&
              readMermaidGfxMeta(e, "mermaidRole") !== MERMAID_GFX_TITLE_ROLE
              ? [e]
              : [];
          }),
          refresh: () => context.gfx.surfaceComponent?.requestUpdate(),
        },
      );
      const ownedDispose = () => {
        if (nativeStatePreviews.get(state.owner) === ownedDispose)
          nativeStatePreviews.delete(state.owner);
        dispose();
      };
      nativeStatePreviews.set(state.owner, ownedDispose);
      return {
        feedback: { changed: true, impact: result.impact },
        dispose: ownedDispose,
      };
    },
    subscribeEditIntent: (handler) => {
      const listener = (event: Event) => {
        const value = (event as CustomEvent<MermaidGfxObjectEditIntent>).detail;
        if (value) handler(value);
      };
      context.host.addEventListener("mermaid-gfx-object-edit", listener);
      return () =>
        context.host.removeEventListener("mermaid-gfx-object-edit", listener);
    },
    requestPlacement: (onPlace, onCancel) => {
      const host = context.host,
        basis = source;
      let pointer: number | null = null,
        point: { centerX: number; centerY: number } | null = null;
      host.setAttribute("data-mermaid-placement-owner", state.owner.id);
      const dispose = () => {
        host.removeAttribute("data-mermaid-placement-owner");
        if (pointer !== null && host.hasPointerCapture(pointer))
          host.releasePointerCapture(pointer);
        host.removeEventListener("pointerdown", down, true);
        host.removeEventListener("pointerup", up, true);
        host.removeEventListener("pointercancel", cancelPointer, true);
        host.removeEventListener("keydown", key, true);
      };
      const consume = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      const abort = () => {
        dispose();
        onCancel?.();
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          consume(event);
          abort();
        }
      };
      const cancelPointer = (event: PointerEvent) => {
        if (event.pointerId === pointer) {
          consume(event);
          abort();
        }
      };
      const down = (event: PointerEvent) => {
        if (
          event.button !== 0 ||
          !event
            .composedPath()
            .some(
              (e) =>
                e instanceof HTMLElement &&
                (e.tagName === "MYOXUS-SURFACE" ||
                  e.tagName === "CANVAS" ||
                  e.classList.contains("edgeless-background") ||
                  e.classList.contains("edgeless-block-children-container")),
            )
        )
          return;
        consume(event);
        if (context.store.readonly || commandPort.getSource() !== basis) {
          abort();
          return;
        }
        pointer = event.pointerId;
        host.setPointerCapture(pointer);
        const [x, y] = context.gfx.viewport.toModelCoordFromClientCoord([
          event.clientX,
          event.clientY,
        ]);
        const current = commandPort.getVisualModel(),
          first = current.nodes[0];
        const element =
          first && getMermaidGfxNode(context.store, state.owner, first.id);
        const origin = Bound.deserialize(element?.xywh ?? state.owner.xywh);
        point = {
          centerX: x - (first ? origin.x - first.x : origin.x),
          centerY: y - (first ? origin.y - first.y : origin.y),
        };
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId !== pointer) return;
        consume(event);
        dispose();
        if (
          !point ||
          context.store.readonly ||
          commandPort.getSource() !== basis
        ) {
          onCancel?.();
          return;
        }
        placement = point;
        onPlace(point);
      };
      // Keep the entire gesture away from the generic ShapeEditor, including its release.
      host.addEventListener("pointerdown", down, true);
      host.addEventListener("pointerup", up, true);
      host.addEventListener("pointercancel", cancelPointer, true);
      host.addEventListener("keydown", key, true);
      return dispose;
    },
    onParentIntent: () => {},
    onEditIntent: () => {},
    onCloseSelection: () => {},
    onWorkareaResize: () => {},
    onEmbeddedActionsInsetChange: () => {},
    resolveReturnFocusTarget: () => context.host,
  };
}
export const stateEdgelessToolbar = {
  readonlySelection: true,
  invalidSourceSelection: true,
  actions: [
    {
      id: "mermaid-state.controls",
      label: mermaidMessages.controlsLabel(),
      control(context) {
        const host = context.std.getOptional(MermaidFamilyReactHostIdentifier),
          props = nativeStateProps(context);
        if (props)
          return host?.toolbarControl(mermaidStateRendererToken, props) ?? null;
        // The native owner's presentation already owns the retained-preview
        // diagnostic. Keep file actions in the Root slot without a second notice.
        return null;
      },
    },
  ],
  suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  when: (context) => {
    const owner = resolveMermaidEdgelessOwnerSelection(context)?.model;
    return Boolean(
      owner &&
      /^\s*stateDiagram(?:-v2)?\b/m.test(getMermaidBlockSource(owner.props)),
    );
  },
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
