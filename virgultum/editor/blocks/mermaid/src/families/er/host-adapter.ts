// SPDX-License-Identifier: AGPL-3.0-or-later
import { MERMAID_GFX_TITLE_ROLE } from "../runtime/gfx-element-roles.js";
import { erCommentMarkers } from "./annotation-projection.js";
import { Bound } from "@virgultum/global/gfx";
import type { MermaidFamilyHostAdapter } from "../runtime/contracts.js";
import type {
  MermaidHostProjectionContext,
  MermaidGfxActionContext,
  MermaidGfxObjectEditIntent,
} from "../runtime/editor-capabilities.js";
import type { ErReactHostProps, ErSelection } from "./react-host-contract.js";
import { mermaidErRendererToken } from "./react-host-contract.js";
import {
  readErProjectionModel,
  reconcileErVisual,
  reconcileErSubgraphLayout,
} from "./source-application.js";
import { erModelToVisual } from "./visual-model.js";
import {
  erPageSelectionTools,
  runErCommand,
  ER_PARENT_ACTIONS,
  ER_PARENT_ACTION_LABELS,
  type ErParentAction,
} from "./actions.js";
import {
  erDeleteImpact,
  deleteErSubgraph,
  erRecordGroup,
  readErConfig,
  erGroupAllowed,
} from "../../engine/er/index.js";
import { mermaidMessages } from "../../i18n.js";
function selection(
  context: MermaidGfxActionContext,
  intent: MermaidGfxObjectEditIntent | null,
): ErSelection | null {
  if (intent?.kind === "detail")
    return {
      kind: "attribute",
      key:
        context.visualModel.nodes
          .flatMap((n) => n.details ?? [])
          .find((d) => d.id === intent.id)?.sourceKey ?? intent.id,
      ownerKey: intent.ownerId,
    };
  const item = intent
    ? { kind: intent.kind, editKey: intent.id }
    : context.selectedItems.length === 1
      ? context.selectedItems[0]
      : null;
  const node =
    item?.kind === "node"
      ? context.visualModel.nodes.find(
          (candidate) => candidate.id === item.editKey,
        )
      : null;
  if (node) return { kind: "entity", key: node.id };
  if (item?.kind === "edge") {
    const edge = context.visualModel.edges.find(
      (candidate) => candidate.id === item.editKey,
    );
    if (edge) return { kind: "relation", key: edge.id };
  }
  if (item?.kind === "subgraph") return { kind: "subgraph", key: item.editKey };
  return null;
}
export function erSelectionImpact(
  model: import("../../engine/er/model.js").MermaidErModel,
  item: ErSelection,
) {
  if (item.kind === "entity") return erDeleteImpact(model, [item.key]);
  if (item.kind === "subgraph")
    return deleteErSubgraph(model, item.key, item.deleteStrategy ?? "delete")
      .impact;
  const group = erRecordGroup(model, item.key);
  return {
    records: (group?.records ?? []).map((r) => ({
      id: r.sourceKey,
      kind: r.kind,
      label: r.raw.trim(),
    })),
  };
}
export type ErCommandPort = {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidGfxActionContext["visualModel"];
  applyVisualModel: MermaidGfxActionContext["applyVisualModel"];
  selectAfterProjection: MermaidGfxActionContext["selectAfterProjection"];
  getPlacement?: () => { centerX: number; centerY: number } | null;
  clearPlacement?: () => void;
  onAttributeIntent?: (intent: MermaidGfxObjectEditIntent) => void;
};
/** Both hosts use the same checked Source command and one owner commit. */
export function createErCommandConsumer(
  port: ErCommandPort,
): ErReactHostProps["onCommand"] {
  return (name, args, basis, requestedPlacement) => {
    if (port.getReadonly())
      return {
        changed: false,
        diagnostic: mermaidMessages.erPatchRejected(),
      };
    const current = port.getSource();
    if (current !== basis)
      return {
        changed: false,
        diagnostic: mermaidMessages.erSourceConflict(),
      };
    const active = readErProjectionModel(current, port.getVisualModel());
    if (!active)
      return {
        changed: false,
        diagnostic: mermaidMessages.erPatchRejected(),
      };
    const result = runErCommand(active, name, args);
    const forceLayout =
      name === "editErAppearance" &&
      Boolean(
        (args[0] as { layout?: boolean } | undefined)?.layout ||
        ((args[0] as { direction?: string } | undefined)?.direction &&
          (args[0] as { direction?: string }).direction !== active.direction),
      );
    if (result.status === "rejected" || (!result.changed && !forceLayout))
      return {
        changed: false,
        diagnostic: result.diagnostic,
        impact: result.impact,
      };
    const parsed = erModelToVisual(result.model),
      stored = port.getVisualModel();
    const visual =
      name === "editErSubgraph" &&
      Object.hasOwn((args[1] as object) ?? {}, "direction")
        ? reconcileErSubgraphLayout(
            result.model,
            parsed,
            stored,
            String(args[0]),
          )
        : reconcileErVisual(parsed, stored, !forceLayout);
    const placement = (requestedPlacement ?? port.getPlacement?.()) as {
      centerX: number;
      centerY: number;
    } | null;
    if (name === "addErEntity" && placement && result.selection) {
      const added = visual.nodes.find((n) => n.id === result.selection);
      if (added) {
        added.x = placement.centerX - added.width / 2;
        added.y = placement.centerY - added.height / 2;
      }
    }
    const committed = port.applyVisualModel(visual, {
      preserveSourceBytes: true,
      ...(result.changed
        ? { sourceWrite: { baseSource: current, source: result.source } }
        : {}),
    });
    if (!committed.applied)
      return {
        changed: false,
        diagnostic: committed.diagnostic ?? mermaidMessages.erPatchRejected(),
      };
    if (result.selection) {
      const attribute = result.model.entities
        .flatMap((n) => n.attributes)
        .find((m) => m.id === result.selection);
      const owner = attribute
        ? result.model.entities.find((n) =>
            n.attributes.some((a) => a.id === attribute.id),
          )?.sourceKey
        : result.selection;
      const kind = visual.nodes.some((n) => n.id === owner)
        ? "node"
        : visual.edges.some((e) => e.id === owner)
          ? "edge"
          : visual.subgraphs?.some((g) => g.id === owner)
            ? "subgraph"
            : null;
      if (kind && owner) port.selectAfterProjection({ editKey: owner, kind });
      if (attribute)
        port.onAttributeIntent?.({
          kind: "detail",
          id: attribute.id,
          ownerId: owner,
        });
    }
    port.clearPlacement?.();
    return {
      changed: true,
      sourceBasis: result.source,
      selection: result.selection,
      impact: result.impact,
    };
  };
}
export function createErEditorProps(
  context: MermaidGfxActionContext,
  host: MermaidHostProjectionContext,
): ErReactHostProps | null {
  const model = readErProjectionModel(host.getSource(), context.visualModel);
  if (!model) return null;
  const intent = host.getTransientState(
    "er.editIntent",
  ) as MermaidGfxObjectEditIntent | null;
  const parentIntent = host.getTransientState(
    "er.parentIntent",
  ) as ErParentAction | null;
  const retainedAttribute = host.getTransientState("er.selectedAttribute") as {
    key: string;
    ownerKey: string;
  } | null;
  const attributeSelected =
    retainedAttribute &&
    context.selectedItems.length === 1 &&
    context.selectedItems[0]?.editKey === retainedAttribute.ownerKey &&
    model.entities.some((n) =>
      n.attributes.some((m) => m.id === retainedAttribute.key),
    );
  if (retainedAttribute && !attributeSelected && context.selectedItems.length)
    host.setTransientState("er.selectedAttribute", null);
  const selected = attributeSelected
    ? { kind: "attribute" as const, ...retainedAttribute }
    : selection(context, intent);
  const onEditIntent = (value: MermaidGfxObjectEditIntent | null) => {
    host.setTransientState("er.editIntent", value);
    if (value?.kind === "detail" && value.ownerId)
      host.setTransientState("er.selectedAttribute", {
        key:
          context.visualModel.nodes
            .flatMap((n) => n.details ?? [])
            .find((d) => d.id === value.id)?.sourceKey ?? value.id,
        ownerKey: value.ownerId,
      });
    else if (value) host.setTransientState("er.selectedAttribute", null);
    context.refreshWorkarea();
    if (!value)
      requestAnimationFrame(() => {
        // A newer object/form may claim focus before the closing draft's next
        // paint. Its focus must not be returned to the previous object.
        if (
          host.getTransientState("er.editIntent") ||
          host.getTransientState("er.parentIntent")
        )
          return;
        const viewport = context
          .resolveReturnFocusTarget()
          ?.closest(".myoxus-mermaid-gfx-viewport");
        const key =
          (
            host.getTransientState("er.selectedAttribute") as {
              key?: string;
            } | null
          )?.key ??
          selected?.key ??
          "";
        const kind =
          selected?.kind === "attribute"
            ? "detail"
            : selected?.kind === "subgraph"
              ? "subgraph"
              : selected?.kind === "relation"
                ? "edge"
                : "node";
        const row =
          key &&
          viewport?.querySelector<HTMLElement>(
            `[data-object-kind="${kind}"][data-mermaid-edit-key="${CSS.escape(key)}"]`,
          );
        (row || context.resolveReturnFocusTarget())?.focus({
          preventScroll: true,
        });
      });
  };
  const selectedKeys = context.selectedItems.map((item) => item.editKey);
  const groupAllowed =
    erGroupAllowed(model, selectedKeys) &&
    (erPageSelectionTools.containerAction?.validate({
      items: context.selectedItems,
      visualModel: context.visualModel,
    }).valid ??
      false);
  return {
    config: readErConfig(model.sourceDocument).config,
    surface: "editor",
    model,
    sourceBasis: model.sourceDocument.source,
    selected,
    selectedKeys:
      selected?.kind === "attribute" ? [selected.key] : selectedKeys,
    selectedAnchor:
      (selected?.kind === "attribute"
        ? context.resolveVisualAnchor("detail", selected.key)
        : null) ??
      intent?.anchor ??
      (selected
        ? context.resolveVisualAnchor(
            selected.kind === "attribute"
              ? "detail"
              : selected.kind === "subgraph"
                ? "subgraph"
                : selected.kind === "relation"
                  ? "edge"
                  : "node",
            selected.key,
          )
        : null) ??
      (selected?.kind === "attribute"
        ? context.resolveVisualAnchor("detail", selected.key)
        : null) ??
      context.selectedNodeAnchor ??
      context.selectedEdgeAnchor ??
      context.selectedSubgraphAnchor,
    intent,
    parentIntent,
    groupAllowed,
    readonly: context.readonly,
    displayOnly: context.displayOnly,
    embedded: context.embedded,
    embeddedEditing: context.embeddedEditing,
    actionTarget: context.actionTarget,
    workarea: context.workarea,
    workareaFooter: context.workareaFooter,
    pageViewport: context.pageViewport,
    placement: host.getTransientState("er.placement") as {
      centerX: number;
      centerY: number;
    } | null,
    commentMarkers: erCommentMarkers(model, context.resolveVisualAnchor),
    getImpact: (item) => erSelectionImpact(model, item),
    resolveAttributeInsertAnchor: (key) => {
      const row = context.resolveVisualAnchor("detail", key),
        owner = model.entities.find((e) =>
          e.attributes.some((a) => a.id === key),
        ),
        card = owner && context.resolveVisualAnchor("node", owner.sourceKey);
      const anchor = row && card ? { left: card.left, top: row.top } : null;
      const viewport = context
        .resolveReturnFocusTarget()
        ?.closest(".myoxus-mermaid-gfx-viewport");
      const rect = viewport?.getBoundingClientRect();
      return anchor && rect
        ? { left: anchor.left + rect.left, top: anchor.top + rect.top }
        : null;
    },
    onCommand: createErCommandConsumer({
      getSource: host.getSource,
      getReadonly: () => host.getReadonly() || context.readonly,
      getVisualModel: () => context.visualModel,
      applyVisualModel: context.applyVisualModel,
      selectAfterProjection: context.selectAfterProjection,
      getPlacement: () =>
        host.getTransientState("er.placement") as {
          centerX: number;
          centerY: number;
        } | null,
      clearPlacement: () => host.setTransientState("er.placement", null),
      onAttributeIntent: (value) => {
        host.setTransientState("er.selectedAttribute", {
          key: value.id,
          ownerKey: value.ownerId,
        });
        host.setTransientState("er.editIntent", value);
      },
    }),
    onParentIntent: (value) => {
      onEditIntent(null);
      host.setTransientState("er.parentIntent", value);
      if (value === "addEntity") {
        host.setTransientState("er.parentIntent", null);
        context.beginNodePlacement((placement) => {
          host.setTransientState("er.placement", placement);
          host.setTransientState("er.parentIntent", "addEntity");
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
export const mermaidErHostAdapter: MermaidFamilyHostAdapter = {
  projectGfx: (resolution) => ({
    kind: "gfx",
    readonlyExploration: true,
    renderSurface: resolution.renderSurface,
    pageSelectionTools: erPageSelectionTools,
    project: (host, displayOnly) =>
      host.renderGfx(resolution.visualModel, {
        displayOnly,
        embeddedFacadeSurface: true,
        renderSurface: resolution.renderSurface,
        pageSelectionTools: erPageSelectionTools,
        resolveDetailVisibilityTarget: () => {
          const edit = (host.getTransientState("er.pendingEditIntent") ??
            host.getTransientState(
              "er.editIntent",
            )) as MermaidGfxObjectEditIntent | null;
          if (edit?.kind === "detail" && edit.ownerId)
            return { ownerId: edit.ownerId, detailId: edit.id };
          const selected = host.getTransientState("er.selectedAttribute") as {
            ownerKey: string;
            key: string;
          } | null;
          return selected
            ? { ownerId: selected.ownerKey, detailId: selected.key }
            : null;
        },
        onObjectEditIntent: (intent) => {
          if (host.getReadonly()) return false;
          if (intent.action === "delete") {
            host.setTransientState("er.parentIntent", "deleteSelection");
            host.setTransientState("er.editIntent", null);
            return true;
          }
          host.setTransientState("er.pendingEditIntent", intent);
          host.setTransientState("er.parentIntent", null);
          return true;
        },
        projectActions: (context) => {
          const edit = host.getTransientState(
            "er.pendingEditIntent",
          ) as MermaidGfxObjectEditIntent | null;
          if (
            edit?.kind === "node" &&
            context.inspector.selectedNode?.id !== edit.id
          )
            context.selectNode(edit.id);
          if (
            edit?.kind === "detail" &&
            edit.ownerId &&
            context.inspector.selectedNode?.id !== edit.ownerId
          )
            context.selectNode(edit.ownerId);
          if (
            edit?.kind === "edge" &&
            context.inspector.selectedEdge?.id !== edit.id
          )
            context.selectEdge(edit.id);
          if (
            edit?.kind === "subgraph" &&
            context.inspector.selectedSubgraph?.id !== edit.id
          )
            context.selectContainer(edit.id);
          if (edit) {
            if (edit.kind === "detail" && edit.ownerId)
              host.setTransientState("er.selectedAttribute", {
                key:
                  context.visualModel.nodes
                    .flatMap((n) => n.details ?? [])
                    .find((d) => d.id === edit.id)?.sourceKey ?? edit.id,
                ownerKey: edit.ownerId,
              });
            else host.setTransientState("er.selectedAttribute", null);
            host.setTransientState(
              "er.editIntent",
              edit.action === "select" ? null : edit,
            );
            host.setTransientState("er.pendingEditIntent", null);
          }
          const active = host.getTransientState(
            "er.editIntent",
          ) as MermaidGfxObjectEditIntent | null;
          const key = active?.kind === "detail" ? active.ownerId : active?.id;
          if (
            !edit &&
            active &&
            !context.selectedItems.some((item) => item.editKey === key)
          )
            host.setTransientState("er.editIntent", null);
          const props = createErEditorProps(context, host);
          // A rights change can invalidate selection while a draft owns focus.
          // Use the existing close boundary to return focus to the surviving
          // object/viewport instead of leaving it on a removed form input.
          if (active && context.readonly && props && !props.intent)
            props.onEditIntent(null);
          host.setSelectionAction(
            context.selectedItems.length
              ? {
                  label: mermaidMessages.visualDelete(),
                  disabled: context.readonly,
                  onSelect: () => {
                    host.setTransientState(
                      "er.parentIntent",
                      "deleteSelection",
                    );
                    context.refreshWorkarea();
                  },
                }
              : null,
          );
          if (!props) return null;
          const body = context.reactHost?.renderFamilyEditor(
            mermaidErRendererToken,
            props,
          );
          return body
            ? {
                body,
                actions: {
                  actions:
                    displayOnly || context.embedded
                      ? []
                      : ER_PARENT_ACTIONS.map((id) => ({
                          id: `er.${id}`,
                          label: ER_PARENT_ACTION_LABELS[id](),
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
    mermaidErHostAdapter.projectGfx({
      visualModel: visual,
      source,
      diagramType: visual.diagramType,
      renderSurface: "core-facade",
    }),
};

import type { ToolbarContext } from "@virgultum/shared/services";
import {
  resolveMermaidEdgelessSelection,
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
import {
  MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  type MermaidFamilyEdgelessToolbarContribution,
  type MermaidPageSelectionItem,
} from "../runtime/contracts.js";
function nativeErProps(context: ToolbarContext): ErReactHostProps | null {
  const state = resolveMermaidEdgelessSelection(context);
  if (!state?.visualModel || !["erDiagram"].includes(state.diagramType))
    return null;
  const source = getMermaidBlockSource(state.owner.props);
  const model = readErProjectionModel(source, state.visualModel);
  if (!model) return null;
  const items = state.selectedModels.flatMap<MermaidPageSelectionItem>(
    (element) => {
      const nodeId = readMermaidGfxNodeId(element),
        edgeId = readMermaidGfxEdgeId(element),
        subgraphId = readMermaidGfxSubgraphId(element);
      if (nodeId) return [{ editKey: nodeId, kind: "node" }];
      if (edgeId) return [{ editKey: edgeId, kind: "edge" }];
      if (subgraphId) return [{ editKey: subgraphId, kind: "subgraph" }];
      return [];
    },
  );
  const uniqueItems = [
    ...new Map(
      items.map((item) => [`${item.kind}:${item.editKey}`, item]),
    ).values(),
  ];
  const detail =
    state.selectedModels.length === 1
      ? readMermaidGfxMeta(state.selectedModels[0], "mermaidDetailSourceKey") ||
        readMermaidGfxMeta(state.selectedModels[0], "mermaidDetailId")
      : "";
  const attribute = model.entities
    .flatMap((n) => n.attributes)
    .find((m) => m.id === detail);
  const item = uniqueItems.length === 1 ? uniqueItems[0] : undefined;
  const titleElement =
    state.selectedModels.length === 1 &&
    readMermaidGfxMeta(state.selectedModels[0], "mermaidRole") ===
      MERMAID_GFX_TITLE_ROLE
      ? state.selectedModels[0]
      : null;
  let selected: ErSelection | null = titleElement
    ? { kind: "title", key: titleElement.id }
    : attribute
      ? {
          kind: "attribute",
          key: attribute.id,
          ownerKey: model.entities.find((n) =>
            n.attributes.some((a) => a.id === attribute.id),
          )?.sourceKey,
        }
      : item
        ? {
            kind:
              item.kind === "edge"
                ? "relation"
                : item.kind === "subgraph"
                  ? "subgraph"
                  : "entity",
            key: item.editKey,
          }
        : null;
  if (
    selected?.kind === "relation" &&
    !model.relationships.some((r) => r.sourceKey === selected?.key)
  )
    selected = null;
  const visualModel = state.visualModel;
  let placement: { centerX: number; centerY: number } | null = null;
  return {
    surface: "controls",
    model,
    config: readErConfig(model.sourceDocument).config,
    sourceBasis: source,
    selected,
    selectedKeys: attribute
      ? [attribute.id]
      : uniqueItems.map((item) => item.editKey),
    selectedAnchor: null,
    intent: null,
    parentIntent: null,
    groupAllowed:
      !attribute &&
      erGroupAllowed(
        model,
        uniqueItems.map((i) => i.editKey),
      ) &&
      (erPageSelectionTools.containerAction?.validate({
        items: uniqueItems,
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
    commentMarkers: erCommentMarkers(model, (kind, key) => {
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
      return { left: left + rect.left, top: top + rect.top };
    }),
    getImpact: (value) => erSelectionImpact(model, value),
    resolveAttributeInsertAnchor: (key) => {
      const element = state.owner.childIds
        .map((id) => state.owner.surface?.getElementById(id))
        .find((child) => readMermaidGfxMeta(child, "mermaidDetailId") === key);
      if (!element?.xywh) return null;
      const bound = Bound.deserialize(element.xywh),
        rect = context.gfx.viewport.boundingClientRect;
      const owner = model.entities.find((e) =>
        e.attributes.some((a) => a.id === key),
      );
      const card = state.owner.childIds
        .map((id) => state.owner.surface?.getElementById(id))
        .find((child) => readMermaidGfxNodeId(child) === owner?.sourceKey);
      const [left, top] = context.gfx.viewport.toViewCoord(
        card?.xywh ? Bound.deserialize(card.xywh).maxX : bound.maxX,
        bound.y,
      );
      return { left: left + rect.left, top: top + rect.top };
    },
    onCommand: createErCommandConsumer({
      getPlacement: () => placement,
      clearPlacement: () => {
        placement = null;
      },
      getSource: () => getMermaidBlockSource(state.owner.props),
      getReadonly: () => context.store.readonly,
      getVisualModel: () =>
        getMermaidVisualModelForEditing(context.std, state.owner) ??
        visualModel,
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
      onAttributeIntent: (value) => {
        const element = state.owner.childIds
          .map((id) => state.owner.surface?.getElementById(id))
          .find(
            (child) =>
              readMermaidGfxMeta(child, "mermaidDetailSourceKey") === value.id,
          );
        if (element)
          context.gfx.selection.set({ editing: false, elements: [element.id] });
      },
      selectAfterProjection: (value) => {
        const element =
          value.kind === "node"
            ? getMermaidGfxNode(context.store, state.owner, value.editKey)
            : value.kind === "edge"
              ? getMermaidGfxConnector(
                  context.store,
                  state.owner,
                  value.editKey,
                )
              : getMermaidGfxSubgraph(
                  context.store,
                  state.owner,
                  value.editKey,
                );
        if (element)
          context.gfx.selection.set({ editing: false, elements: [element.id] });
      },
    }),
    subscribeEditIntent: (handler) => {
      const listener = (event: Event) => {
        const intent = (event as CustomEvent<MermaidGfxObjectEditIntent>)
          .detail;
        if (intent) handler(intent);
      };
      context.host.addEventListener("mermaid-gfx-object-edit", listener);
      return () =>
        context.host.removeEventListener("mermaid-gfx-object-edit", listener);
    },
    requestPlacement: (onPlace, onCancel) => {
      const host = context.host;
      host.setAttribute("data-mermaid-placement-owner", state.owner.id);
      const dispose = () => {
        host.removeAttribute("data-mermaid-placement-owner");
        host.removeEventListener("pointerdown", place, true);
        host.removeEventListener("keydown", cancel, true);
      };
      const cancel = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          dispose();
          onCancel?.();
          event.preventDefault();
          event.stopPropagation();
        }
      };
      const place = (event: PointerEvent) => {
        if (
          event.button !== 0 ||
          context.store.readonly ||
          !event
            .composedPath()
            .some(
              (element) =>
                element instanceof HTMLElement &&
                (element.tagName === "MYOXUS-SURFACE" ||
                  element.tagName === "CANVAS" ||
                  element.classList.contains("edgeless-background") ||
                  element.classList.contains(
                    "edgeless-block-children-container",
                  )),
            )
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dispose();
        const [x, y] = context.gfx.viewport.toModelCoordFromClientCoord([
          event.clientX,
          event.clientY,
        ]);
        const current = getMermaidVisualModelForEditing(
            context.std,
            state.owner,
          ),
          first = current?.nodes[0];
        const element =
          first && getMermaidGfxNode(context.store, state.owner, first.id);
        const origin = element
          ? Bound.deserialize(element.xywh)
          : Bound.deserialize(state.owner.xywh);
        placement = {
          centerX: x - (first ? origin.x - first.x : origin.x),
          centerY: y - (first ? origin.y - first.y : origin.y),
        };
        onPlace(placement);
      };
      host.addEventListener("pointerdown", place, true);
      host.addEventListener("keydown", cancel, true);
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
export const erEdgelessToolbar = {
  readonlySelection: true,
  actions: [
    {
      id: "mermaid-er.controls",
      label: mermaidMessages.controlsLabel(),
      control(context) {
        const props = nativeErProps(context);
        return props
          ? (context.std
              .getOptional(MermaidFamilyReactHostIdentifier)
              ?.toolbarControl(mermaidErRendererToken, props) ?? null)
          : null;
      },
    },
  ],
  suppressBaseActionIds: MERMAID_MANAGED_ELEMENT_UNSAFE_BASE_ACTION_IDS,
  when: (context) => nativeErProps(context) !== null,
} as const satisfies MermaidFamilyEdgelessToolbarContribution;
